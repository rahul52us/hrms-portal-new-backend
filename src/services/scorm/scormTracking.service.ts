import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import Course from "../../schemas/course/Course";
import ScormTracking from "../../schemas/course/ScormTracking";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import UserSectionProgress from "../../schemas/course/UserSectionProgress";
import {
  assertEnrollmentAccess,
  buildCourseStructureLookup,
  COMPLETED_STATUSES,
  computeIncrementalSessionCentiseconds,
  DEFAULT_SCORM_TIME,
  deriveProgress,
  findCourseSectionStructure,
  formatScorm12Time,
  normalizeCompletionStatus,
  normalizeLessonStatus,
  normalizeObjectId,
  normalizeProgressMeasure,
  normalizeScore,
  normalizeScorm12Time,
  normalizeSuccessStatus,
  normalizeString,
  parseScorm12Time,
  resolveScormLessonStatus,
  resolveProgressUserId,
  serializeCourseProgress,
  serializeSectionProgress,
  syncAggregateCourseProgress,
  syncEnrollmentProgress,
} from "./scormTracking.helpers";
import { getScormAssetSlideMetadata } from "./scormStorage.service";
import { extractNormalizedScormInteractions, mergeScormTrackingInteractions, serializeScormTrackingRecord } from "./scormAnswerReview.helpers";
import { getCourseQuizAnswerSectionsForUser } from "../course/courseQuiz.service";
import {
  enrichInteractionWithQuestionBank,
  extractScormPackageIdFromSectionContext,
} from "./scormQuestionBank.service";

type TrackingMode = "commit" | "finish";
const FINISH_COMPLETION_THRESHOLD = 99;
const COURSE_LEVEL_MODULE_ID = "__course__";
const COURSE_LEVEL_SECTION_ID = "__course__";

type TrackingSectionContext = {
  moduleId: string;
  moduleTitle: string;
  sectionId: string;
  sectionTitle: string;
  previewUrl: string;
  slideCount: number | null;
} | null;

type NormalizedTrackingPayload = {
  userId: string;
  courseId: string;
  moduleId: string;
  sectionId: string;
  scormVersion: "1.2" | "2004";
  lessonStatus: any;
  completionStatus: string;
  successStatus: string;
  progressMeasure: number | null;
  score: number | null;
  scoreRaw: number | null;
  scoreScaled: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  lessonLocation: string;
  suspendData: string;
  decodedSuspendData: any;
  sessionTime: string;
  totalTime: string;
  interactions: ReturnType<typeof extractNormalizedScormInteractions>;
};

function isExplicitRestartRequested(req: any) {
  return req.body?.startOver === true || req.body?.restart === true;
}

function resolveExistingSectionState(existingProgress: any, existingTracking: any) {
  return existingProgress || existingTracking || null;
}

function normalizeScormVersion(value: unknown): "1.2" | "2004" {
  return normalizeString(value) === "2004" ? "2004" : "1.2";
}

function resolveScoreFields(body: any) {
  const scoreRaw = normalizeScore(body.score_raw ?? body.score);
  const scoreScaled = normalizeScore(body.score_scaled);
  const scoreMin = normalizeScore(body.score_min);
  const scoreMax = normalizeScore(body.score_max);
  const score =
    scoreRaw ??
    (scoreScaled !== null
      ? Math.round(Math.max(-1, Math.min(1, scoreScaled)) * 10000) / 100
      : null);

  return {
    score,
    scoreRaw,
    scoreScaled,
    scoreMin,
    scoreMax,
  };
}

function resolveCompletionState(
  lessonStatus: any,
  progress: number,
  completionStatus?: string | null,
  successStatus?: string | null,
  options?: { enableProgressThresholdCompletion?: boolean; progressCompletionThreshold?: number }
) {
  const normalizedLessonStatus = normalizeLessonStatus(lessonStatus, "not_attempted");
  const normalizedCompletionStatus = normalizeCompletionStatus(completionStatus);
  const normalizedSuccessStatus = normalizeSuccessStatus(successStatus);
  const completionThreshold = Number(options?.progressCompletionThreshold ?? 100);
  const canUseThresholdCompletion = Boolean(options?.enableProgressThresholdCompletion) && completionThreshold > 0;
  const hasExplicitCompletionSignal =
    COMPLETED_STATUSES.has(normalizedLessonStatus) ||
    normalizedCompletionStatus === "completed" ||
    normalizedSuccessStatus === "passed";
  const hasExplicitFailedSignal = normalizedLessonStatus === "failed" || normalizedSuccessStatus === "failed";
  const hasReachedHardCompletion = hasExplicitCompletionSignal || progress >= 100;
  const hasReachedThresholdCompletion = canUseThresholdCompletion && progress >= completionThreshold;
  const hasReachedCompletion = hasReachedHardCompletion || hasReachedThresholdCompletion;

  if (normalizedLessonStatus === "failed") {
    return {
      lessonStatus: normalizedLessonStatus,
      progress: Math.max(0, Math.min(100, progress)),
      isCompleted: false,
    };
  }

  if (COMPLETED_STATUSES.has(normalizedLessonStatus)) {
    return {
      lessonStatus: normalizedLessonStatus,
      progress: 100,
      isCompleted: true,
    };
  }

  if (hasReachedCompletion && !hasExplicitFailedSignal) {
    return {
      lessonStatus: "completed" as const,
      progress: 100,
      isCompleted: true,
    };
  }

  return {
    lessonStatus: normalizedLessonStatus,
    progress,
    isCompleted: false,
  };
}

async function resolveScormSlideCount(assetPath?: string | null, storedSlideCount?: number | null) {
  // Prefer the pre-computed slide count stored on the course document at upload time.
  if (storedSlideCount != null && Number.isFinite(storedSlideCount) && storedSlideCount > 0) {
    return storedSlideCount;
  }

  const normalizedAssetPath = normalizeString(assetPath);
  if (!normalizedAssetPath) {
    return null;
  }

  try {
    const metadata = await getScormAssetSlideMetadata(normalizedAssetPath);
    return metadata?.totalSlides ?? null;
  } catch (error) {
    console.warn(`Failed to resolve SCORM slide metadata for ${normalizedAssetPath}.`, error);
    return null;
  }
}

async function resolveTrackingSectionContext(courseId: string, moduleId?: unknown, sectionId?: unknown) {
  const normalizedModuleId = normalizeString(moduleId);
  const normalizedSectionId = normalizeString(sectionId);

  if (!normalizedModuleId && !normalizedSectionId) {
    return {
      course: null,
      sectionContext: null as TrackingSectionContext,
    };
  }

  if (!normalizedSectionId) {
    throw generateError("sectionId is required when tracking section progress", 422);
  }

  const course = await Course.findById(courseId).lean();
  if (!course) {
    throw generateError("Course not found", 404);
  }

  return {
    course,
    sectionContext: findCourseSectionStructure(course, normalizedModuleId, normalizedSectionId),
  };
}

function normalizeTrackingPayload(
  req: any,
  fallbackProgress?: any,
  sectionContext?: TrackingSectionContext
): NormalizedTrackingPayload {
  const userId = resolveProgressUserId(req, req.body.userId);
  const courseId = normalizeObjectId(req.body.courseId, "courseId");
  const fallbackLessonStatus = normalizeLessonStatus(fallbackProgress?.lessonStatus, "not_attempted");
  const completionStatus = normalizeCompletionStatus(req.body.completion_status);
  const successStatus = normalizeSuccessStatus(req.body.success_status);
  const lessonStatus = resolveScormLessonStatus({
    lessonStatus: req.body.lesson_status,
    completionStatus,
    successStatus,
    fallback: fallbackLessonStatus,
  });
  const sessionTime = normalizeScorm12Time(req.body.session_time, fallbackProgress?.sessionTime || DEFAULT_SCORM_TIME);
  const totalTime = normalizeScorm12Time(req.body.total_time, fallbackProgress?.totalTime || DEFAULT_SCORM_TIME);
  const suspendData = normalizeString(req.body.suspend_data) || normalizeString(fallbackProgress?.suspendData);
  const scoreFields = resolveScoreFields(req.body);

  return {
    userId,
    courseId,
    moduleId: normalizeString(req.body.moduleId) || sectionContext?.moduleId || "",
    sectionId: normalizeString(req.body.sectionId) || sectionContext?.sectionId || "",
    scormVersion: normalizeScormVersion(req.body.scorm_version),
    lessonStatus,
    completionStatus,
    successStatus,
    progressMeasure: normalizeProgressMeasure(req.body.progress_measure),
    ...scoreFields,
    lessonLocation: normalizeString(req.body.lesson_location ?? req.body.location),
    suspendData,
    decodedSuspendData: req.body.decoded_suspend_data || null,
    sessionTime,
    totalTime,
    interactions: extractNormalizedScormInteractions({
      interactions: req.body.interactions,
      suspendData,
      decodedSuspendData: req.body.decoded_suspend_data || null,
    }),
  };
}

function logMissingScormPackageId(context: Record<string, unknown>) {
  console.warn("[ScormTracking] Unable to resolve scormPackageId for enrichment", context);
}

async function initializeSectionTracking(
  req: any,
  res: Response,
  next: NextFunction,
  sectionContext: NonNullable<TrackingSectionContext>
) {
  try {
    const userId = resolveProgressUserId(req, req.body.userId);
    const courseId = normalizeObjectId(req.body.courseId, "courseId");

    const [, existingProgress, existingTracking] = await Promise.all([
      assertEnrollmentAccess(userId, courseId, req),
      UserSectionProgress.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
        moduleId: sectionContext.moduleId,
        sectionId: sectionContext.sectionId,
      }).lean(),
      ScormTracking.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
        moduleId: sectionContext.moduleId,
        sectionId: sectionContext.sectionId,
      }).lean(),
    ]);

    const existingState = resolveExistingSectionState(existingProgress, existingTracking);
    const slideCount = await resolveScormSlideCount(sectionContext.previewUrl, sectionContext.slideCount);
    const isFreshAttempt = isExplicitRestartRequested(req);
    const nextAttempts = Math.max(
      isFreshAttempt ? Number(existingState?.attempts || 0) + 1 : Number(existingState?.attempts || 1),
      1
    );
    let nextLessonStatus = isFreshAttempt ? "not_attempted" : existingState?.lessonStatus || "not_attempted";
    const nextScore = isFreshAttempt ? null : existingState?.score ?? null;
    const nextLessonLocation = isFreshAttempt ? "" : existingState?.lessonLocation || "";
    const nextSuspendData = isFreshAttempt ? "" : existingState?.suspendData || "";
    const nextTotalTime = normalizeScorm12Time(existingState?.totalTime, DEFAULT_SCORM_TIME);
    const nextSessionTime = isFreshAttempt
      ? DEFAULT_SCORM_TIME
      : normalizeScorm12Time(existingState?.sessionTime, DEFAULT_SCORM_TIME);
    
    let nextProgress = deriveProgress(nextLessonStatus, {
      lessonLocation: nextLessonLocation,
      suspendData: nextSuspendData,
      score: nextScore,
      totalTime: nextTotalTime,
      sessionTime: nextSessionTime,
      slideCount,
      interactions: isFreshAttempt ? [] : (existingTracking?.interactions || []),
    });
    const completionState = resolveCompletionState(nextLessonStatus, nextProgress);
    nextLessonStatus = completionState.lessonStatus;
    nextProgress = completionState.progress;
    const nextIsCompleted = completionState.isCompleted;

    const [progressDoc] = await Promise.all([
      UserSectionProgress.findOneAndUpdate(
        {
          userId: new mongoose.Types.ObjectId(userId),
          courseId: new mongoose.Types.ObjectId(courseId),
          moduleId: sectionContext.moduleId,
          sectionId: sectionContext.sectionId,
        },
        {
          $set: {
            lessonStatus: nextLessonStatus,
            completionStatus: isFreshAttempt ? "" : existingProgress?.completionStatus || "",
            successStatus: isFreshAttempt ? "" : existingProgress?.successStatus || "",
            progressMeasure: isFreshAttempt ? null : existingProgress?.progressMeasure ?? null,
            isCompleted: nextIsCompleted,
            completedAt: nextIsCompleted ? existingProgress?.completedAt || new Date() : null,
            progress: nextProgress,
            score: nextScore,
            scoreRaw: isFreshAttempt ? null : existingProgress?.scoreRaw ?? null,
            scoreScaled: isFreshAttempt ? null : existingProgress?.scoreScaled ?? null,
            scoreMin: isFreshAttempt ? null : existingProgress?.scoreMin ?? null,
            scoreMax: isFreshAttempt ? null : existingProgress?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: nextSessionTime,
            totalTime: nextTotalTime,
            attempts: nextAttempts,
            lastAccessed: new Date(),
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
      ScormTracking.findOneAndUpdate(
        {
          userId: new mongoose.Types.ObjectId(userId),
          courseId: new mongoose.Types.ObjectId(courseId),
          moduleId: sectionContext.moduleId,
          sectionId: sectionContext.sectionId,
        },
        {
          $set: {
            lessonStatus: nextLessonStatus,
            completionStatus: isFreshAttempt ? "" : existingTracking?.completionStatus || "",
            successStatus: isFreshAttempt ? "" : existingTracking?.successStatus || "",
            progressMeasure: isFreshAttempt ? null : existingTracking?.progressMeasure ?? null,
            progress: nextProgress,
            score: nextScore,
            scoreRaw: isFreshAttempt ? null : existingTracking?.scoreRaw ?? null,
            scoreScaled: isFreshAttempt ? null : existingTracking?.scoreScaled ?? null,
            scoreMin: isFreshAttempt ? null : existingTracking?.scoreMin ?? null,
            scoreMax: isFreshAttempt ? null : existingTracking?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: nextSessionTime,
            totalTime: nextTotalTime,
            attempts: nextAttempts,
            lastAccessed: new Date(),
            interactions: isFreshAttempt
              ? []
              : mergeScormTrackingInteractions(existingTracking?.interactions || [], []),
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
    ]);

    return res.status(200).send({
      status: "success",
      message: "SCORM progress initialized successfully",
      data: serializeSectionProgress(progressDoc),
    });
  } catch (err: any) {
    next(err);
  }
}

async function upsertCourseTrackingState(req: any, res: Response, next: NextFunction, mode: TrackingMode) {
  try {
    const requestedUserId = resolveProgressUserId(req, req.body.userId);
    const requestedCourseId = normalizeObjectId(req.body.courseId, "courseId");

    await assertEnrollmentAccess(requestedUserId, requestedCourseId, req);

    const [existingProgress, existingTracking, course] = await Promise.all([
      UserCourseProgress.findOne({
        userId: new mongoose.Types.ObjectId(requestedUserId),
        courseId: new mongoose.Types.ObjectId(requestedCourseId),
      }),
      ScormTracking.findOne({
        userId: new mongoose.Types.ObjectId(requestedUserId),
        courseId: new mongoose.Types.ObjectId(requestedCourseId),
        moduleId: COURSE_LEVEL_MODULE_ID,
        sectionId: COURSE_LEVEL_SECTION_ID,
      }),
      Course.findById(requestedCourseId).select("scormFilePath").lean(),
    ]);

    const payload = normalizeTrackingPayload(req, existingProgress);

    const slideCount = await resolveScormSlideCount(course?.scormFilePath);
    const previousSessionTime = existingProgress?.sessionTime || DEFAULT_SCORM_TIME;
    const existingTotalCentiseconds = parseScorm12Time(existingProgress?.totalTime || DEFAULT_SCORM_TIME) || 0;
    const incomingTotalCentiseconds = parseScorm12Time(payload.totalTime);
    const sessionDelta = computeIncrementalSessionCentiseconds(previousSessionTime, payload.sessionTime);
    const computedTotalCentiseconds = existingTotalCentiseconds + sessionDelta;
    const nextTotalCentiseconds =
      incomingTotalCentiseconds !== null
        ? Math.max(existingTotalCentiseconds, computedTotalCentiseconds, incomingTotalCentiseconds)
        : computedTotalCentiseconds;
    const nextTotalTime = formatScorm12Time(nextTotalCentiseconds);
    const nextScore = payload.score ?? existingProgress?.score ?? null;
    const nextLessonLocation = payload.lessonLocation || existingProgress?.lessonLocation || "";
    const nextSuspendData = payload.suspendData || existingProgress?.suspendData || "";
    const existingCompleted = COMPLETED_STATUSES.has(
      normalizeLessonStatus(existingProgress?.lessonStatus)
    );
    let nextLessonStatus = payload.lessonStatus || existingProgress?.lessonStatus || "not_attempted";
    const mergedInteractions = mergeScormTrackingInteractions(
      existingTracking?.interactions || [],
      payload.interactions
    );
    let nextProgress = deriveProgress(nextLessonStatus, {
      lessonLocation: nextLessonLocation,
      suspendData: nextSuspendData,
      score: nextScore,
      totalTime: nextTotalTime,
      sessionTime: payload.sessionTime,
      progressMeasure: payload.progressMeasure,
      completionStatus: payload.completionStatus,
      successStatus: payload.successStatus,
      scoreRaw: payload.scoreRaw,
      scoreScaled: payload.scoreScaled,
      scoreMin: payload.scoreMin,
      scoreMax: payload.scoreMax,
      slideCount,
      interactions: mergedInteractions,
    });
    if (!existingCompleted) {
      nextProgress = Math.max(Number(existingProgress?.progress || 0), nextProgress);
    }
    const completionState = resolveCompletionState(
      existingCompleted ? existingProgress?.lessonStatus : nextLessonStatus,
      existingCompleted ? 100 : nextProgress,
      existingCompleted ? "completed" : payload.completionStatus,
      existingCompleted ? normalizeSuccessStatus(existingProgress?.successStatus) : payload.successStatus,
      {
        enableProgressThresholdCompletion: mode === "finish",
        progressCompletionThreshold: FINISH_COMPLETION_THRESHOLD,
      }
    );
    nextLessonStatus = completionState.lessonStatus;
    nextProgress = completionState.progress;

    const progressQuery = {
      userId: new mongoose.Types.ObjectId(payload.userId),
      courseId: new mongoose.Types.ObjectId(payload.courseId),
    };
    const [progressDoc] = await Promise.all([
      UserCourseProgress.findOneAndUpdate(
        progressQuery,
        {
          $set: {
            lessonStatus: nextLessonStatus,
            completionStatus: existingCompleted
              ? normalizeCompletionStatus(existingProgress?.completionStatus) || "completed"
              : payload.completionStatus,
            successStatus: existingCompleted
              ? normalizeSuccessStatus(existingProgress?.successStatus)
              : payload.successStatus,
            progressMeasure: Math.max(
              Number(existingProgress?.progressMeasure || 0),
              Number(payload.progressMeasure || 0)
            ),
            progress: nextProgress,
            score: nextScore,
            scoreRaw: payload.scoreRaw ?? existingProgress?.scoreRaw ?? null,
            scoreScaled: payload.scoreScaled ?? existingProgress?.scoreScaled ?? null,
            scoreMin: payload.scoreMin ?? existingProgress?.scoreMin ?? null,
            scoreMax: payload.scoreMax ?? existingProgress?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: payload.sessionTime,
            totalTime: nextTotalTime,
            lastAccessed: new Date(),
          },
          $unset: {
            decoded_suspend_data: "",
          },
          $setOnInsert: {
            attempts: 1,
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
      ScormTracking.findOneAndUpdate(
        {
          ...progressQuery,
          moduleId: COURSE_LEVEL_MODULE_ID,
          sectionId: COURSE_LEVEL_SECTION_ID,
        },
        {
          $set: {
            scormVersion: payload.scormVersion,
            lessonStatus: nextLessonStatus,
            completionStatus: existingCompleted ? "completed" : payload.completionStatus,
            successStatus: existingCompleted
              ? normalizeSuccessStatus(existingProgress?.successStatus)
              : payload.successStatus,
            progressMeasure: Math.max(
              Number(existingTracking?.progressMeasure || 0),
              Number(payload.progressMeasure || 0)
            ),
            progress: nextProgress,
            score: nextScore,
            scoreRaw: payload.scoreRaw ?? existingTracking?.scoreRaw ?? null,
            scoreScaled: payload.scoreScaled ?? existingTracking?.scoreScaled ?? null,
            scoreMin: payload.scoreMin ?? existingTracking?.scoreMin ?? null,
            scoreMax: payload.scoreMax ?? existingTracking?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: payload.sessionTime,
            totalTime: nextTotalTime,
            attempts: Math.max(Number(existingTracking?.attempts || 1), 1),
            lastAccessed: new Date(),
            interactions: mergedInteractions,
          },
          $unset: {
            decoded_suspend_data: "",
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
    ]);

    await syncEnrollmentProgress({
      userId: payload.userId,
      courseId: payload.courseId,
      lessonStatus: nextLessonStatus,
      progress: nextProgress,
    });

    return res.status(200).send({
      status: "success",
      message: mode === "finish" ? "SCORM progress finalized successfully" : "SCORM progress committed successfully",
      data: serializeCourseProgress(progressDoc),
    });
  } catch (err: any) {
    next(err);
  }
}

async function upsertSectionTrackingState(
  req: any,
  res: Response,
  next: NextFunction,
  mode: TrackingMode,
  sectionContext: NonNullable<TrackingSectionContext>
) {
  try {
    const requestedUserId = resolveProgressUserId(req, req.body.userId);
    const requestedCourseId = normalizeObjectId(req.body.courseId, "courseId");

    await assertEnrollmentAccess(requestedUserId, requestedCourseId, req);

    const [existingProgress, existingTracking] = await Promise.all([
      UserSectionProgress.findOne({
        userId: new mongoose.Types.ObjectId(requestedUserId),
        courseId: new mongoose.Types.ObjectId(requestedCourseId),
        moduleId: sectionContext.moduleId,
        sectionId: sectionContext.sectionId,
      }),
      ScormTracking.findOne({
        userId: new mongoose.Types.ObjectId(requestedUserId),
        courseId: new mongoose.Types.ObjectId(requestedCourseId),
        moduleId: sectionContext.moduleId,
        sectionId: sectionContext.sectionId,
      }),
    ]);
    const existingState = resolveExistingSectionState(existingProgress, existingTracking);
    const payload = normalizeTrackingPayload(req, existingState, sectionContext);

    const slideCount = await resolveScormSlideCount(sectionContext.previewUrl, sectionContext.slideCount);
    const previousSessionTime = existingState?.sessionTime || DEFAULT_SCORM_TIME;
    const existingTotalCentiseconds = parseScorm12Time(existingState?.totalTime || DEFAULT_SCORM_TIME) || 0;
    const incomingTotalCentiseconds = parseScorm12Time(payload.totalTime);
    const sessionDelta = computeIncrementalSessionCentiseconds(previousSessionTime, payload.sessionTime);
    const computedTotalCentiseconds = existingTotalCentiseconds + sessionDelta;
    const nextTotalCentiseconds =
      incomingTotalCentiseconds !== null
        ? Math.max(existingTotalCentiseconds, computedTotalCentiseconds, incomingTotalCentiseconds)
        : computedTotalCentiseconds;
    const nextTotalTime = formatScorm12Time(nextTotalCentiseconds);
    const nextScore = payload.score ?? existingState?.score ?? null;
    const nextLessonLocation = payload.lessonLocation || existingState?.lessonLocation || "";
    const nextSuspendData = payload.suspendData || existingState?.suspendData || "";
    const existingCompleted = Boolean(
      existingProgress?.isCompleted ||
      COMPLETED_STATUSES.has(normalizeLessonStatus(existingState?.lessonStatus))
    );
    let nextLessonStatus = payload.lessonStatus || existingState?.lessonStatus || "not_attempted";
    const nextAttempts = Math.max(Number(existingState?.attempts || 1), 1);
    
    const mergedInteractions = mergeScormTrackingInteractions(
      existingTracking?.interactions || [],
      payload.interactions
    );

    let nextProgress = deriveProgress(nextLessonStatus, {
      lessonLocation: nextLessonLocation,
      suspendData: nextSuspendData,
      score: nextScore,
      totalTime: nextTotalTime,
      sessionTime: payload.sessionTime,
      progressMeasure: payload.progressMeasure,
      completionStatus: payload.completionStatus,
      successStatus: payload.successStatus,
      scoreRaw: payload.scoreRaw,
      scoreScaled: payload.scoreScaled,
      scoreMin: payload.scoreMin,
      scoreMax: payload.scoreMax,
      slideCount,
      interactions: mergedInteractions,
    });
    if (!existingCompleted) {
      nextProgress = Math.max(Number(existingProgress?.progress || 0), nextProgress);
    }
    const completionState = resolveCompletionState(
      existingCompleted ? existingState?.lessonStatus : nextLessonStatus,
      existingCompleted ? 100 : nextProgress,
      existingCompleted ? "completed" : payload.completionStatus,
      existingCompleted ? normalizeSuccessStatus(existingState?.successStatus) : payload.successStatus,
      {
        enableProgressThresholdCompletion: mode === "finish",
        progressCompletionThreshold: FINISH_COMPLETION_THRESHOLD,
      }
    );
    nextLessonStatus = completionState.lessonStatus;
    nextProgress = completionState.progress;
    const nextIsCompleted = completionState.isCompleted;

    const [progressDoc] = await Promise.all([
      UserSectionProgress.findOneAndUpdate(
        {
          userId: new mongoose.Types.ObjectId(payload.userId),
          courseId: new mongoose.Types.ObjectId(payload.courseId),
          moduleId: sectionContext.moduleId,
          sectionId: sectionContext.sectionId,
        },
        {
          $set: {
            lessonStatus: nextLessonStatus,
            completionStatus: existingCompleted
              ? normalizeCompletionStatus(existingProgress?.completionStatus) || "completed"
              : payload.completionStatus,
            successStatus: existingCompleted
              ? normalizeSuccessStatus(existingProgress?.successStatus)
              : payload.successStatus,
            progressMeasure: Math.max(
              Number(existingProgress?.progressMeasure || 0),
              Number(payload.progressMeasure || 0)
            ),
            isCompleted: nextIsCompleted,
            completedAt: nextIsCompleted ? existingProgress?.completedAt || new Date() : null,
            progress: nextProgress,
            score: nextScore,
            scoreRaw: payload.scoreRaw ?? existingProgress?.scoreRaw ?? null,
            scoreScaled: payload.scoreScaled ?? existingProgress?.scoreScaled ?? null,
            scoreMin: payload.scoreMin ?? existingProgress?.scoreMin ?? null,
            scoreMax: payload.scoreMax ?? existingProgress?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: payload.sessionTime,
            totalTime: nextTotalTime,
            attempts: nextAttempts,
            lastAccessed: new Date(),
          },
          $unset: {
            decoded_suspend_data: "",
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
      ScormTracking.findOneAndUpdate(
        {
          userId: new mongoose.Types.ObjectId(payload.userId),
          courseId: new mongoose.Types.ObjectId(payload.courseId),
          moduleId: sectionContext.moduleId,
          sectionId: sectionContext.sectionId,
        },
        {
          $set: {
            scormVersion: payload.scormVersion,
            lessonStatus: nextLessonStatus,
            completionStatus: existingCompleted ? "completed" : payload.completionStatus,
            successStatus: existingCompleted
              ? normalizeSuccessStatus(existingTracking?.successStatus)
              : payload.successStatus,
            progressMeasure: Math.max(
              Number(existingTracking?.progressMeasure || 0),
              Number(payload.progressMeasure || 0)
            ),
            progress: nextProgress,
            score: nextScore,
            scoreRaw: payload.scoreRaw ?? existingTracking?.scoreRaw ?? null,
            scoreScaled: payload.scoreScaled ?? existingTracking?.scoreScaled ?? null,
            scoreMin: payload.scoreMin ?? existingTracking?.scoreMin ?? null,
            scoreMax: payload.scoreMax ?? existingTracking?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: payload.sessionTime,
            totalTime: nextTotalTime,
            attempts: nextAttempts,
            lastAccessed: new Date(),
            interactions: mergedInteractions,
          },
          $unset: {
            decoded_suspend_data: "",
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
    ]);

    const aggregateResult = await syncAggregateCourseProgress({
      userId: payload.userId,
      courseId: payload.courseId,
    });

    return res.status(200).send({
      status: "success",
      message: mode === "finish" ? "SCORM progress finalized successfully" : "SCORM progress committed successfully",
      data: {
        ...serializeSectionProgress(progressDoc),
        courseProgress: aggregateResult?.course || null,
      },
    });
  } catch (err: any) {
    next(err);
  }
}

export const initializeScormTrackingService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const courseId = normalizeObjectId(req.body.courseId, "courseId");
    const { sectionContext } = await resolveTrackingSectionContext(courseId, req.body.moduleId, req.body.sectionId);

    if (sectionContext) {
      return initializeSectionTracking(req, res, next, sectionContext);
    }

    const userId = resolveProgressUserId(req, req.body.userId);
    const [, existingProgress, existingTracking, course] = await Promise.all([
      assertEnrollmentAccess(userId, courseId, req),
      UserCourseProgress.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
      }).lean(),
      ScormTracking.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
        moduleId: COURSE_LEVEL_MODULE_ID,
        sectionId: COURSE_LEVEL_SECTION_ID,
      }).lean(),
      Course.findById(courseId).select("scormFilePath").lean(),
    ]);

    const slideCount = await resolveScormSlideCount(course?.scormFilePath);
    const isFreshAttempt = isExplicitRestartRequested(req);
    const nextAttempts = Math.max(
      isFreshAttempt ? Number(existingProgress?.attempts || 0) + 1 : Number(existingProgress?.attempts || 1),
      1
    );
    let nextLessonStatus = isFreshAttempt ? "not_attempted" : existingProgress?.lessonStatus || "not_attempted";
    const nextScore = isFreshAttempt ? null : existingProgress?.score ?? null;
    const nextLessonLocation = isFreshAttempt ? "" : existingProgress?.lessonLocation || "";
    const nextSuspendData = isFreshAttempt ? "" : existingProgress?.suspendData || "";
    const nextTotalTime = normalizeScorm12Time(existingProgress?.totalTime, DEFAULT_SCORM_TIME);
    const nextSessionTime = isFreshAttempt
      ? DEFAULT_SCORM_TIME
      : normalizeScorm12Time(existingProgress?.sessionTime, DEFAULT_SCORM_TIME);
    
    let nextProgress = deriveProgress(nextLessonStatus, {
      lessonLocation: nextLessonLocation,
      suspendData: nextSuspendData,
      score: nextScore,
      totalTime: nextTotalTime,
      sessionTime: nextSessionTime,
      slideCount,
    });
    const completionState = resolveCompletionState(nextLessonStatus, nextProgress);
    nextLessonStatus = completionState.lessonStatus;
    nextProgress = completionState.progress;

    const progressQuery = {
      userId: new mongoose.Types.ObjectId(userId),
      courseId: new mongoose.Types.ObjectId(courseId),
    };
    const [progressDoc] = await Promise.all([
      UserCourseProgress.findOneAndUpdate(
        progressQuery,
        {
          $set: {
            lessonStatus: nextLessonStatus,
            completionStatus: isFreshAttempt ? "" : existingProgress?.completionStatus || "",
            successStatus: isFreshAttempt ? "" : existingProgress?.successStatus || "",
            progressMeasure: isFreshAttempt ? null : existingProgress?.progressMeasure ?? null,
            progress: nextProgress,
            score: nextScore,
            scoreRaw: isFreshAttempt ? null : existingProgress?.scoreRaw ?? null,
            scoreScaled: isFreshAttempt ? null : existingProgress?.scoreScaled ?? null,
            scoreMin: isFreshAttempt ? null : existingProgress?.scoreMin ?? null,
            scoreMax: isFreshAttempt ? null : existingProgress?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: nextSessionTime,
            totalTime: nextTotalTime,
            attempts: nextAttempts,
            lastAccessed: new Date(),
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
      ScormTracking.findOneAndUpdate(
        {
          ...progressQuery,
          moduleId: COURSE_LEVEL_MODULE_ID,
          sectionId: COURSE_LEVEL_SECTION_ID,
        },
        {
          $set: {
            lessonStatus: nextLessonStatus,
            completionStatus: isFreshAttempt ? "" : existingTracking?.completionStatus || "",
            successStatus: isFreshAttempt ? "" : existingTracking?.successStatus || "",
            progressMeasure: isFreshAttempt ? null : existingTracking?.progressMeasure ?? null,
            progress: nextProgress,
            score: nextScore,
            scoreRaw: isFreshAttempt ? null : existingTracking?.scoreRaw ?? null,
            scoreScaled: isFreshAttempt ? null : existingTracking?.scoreScaled ?? null,
            scoreMin: isFreshAttempt ? null : existingTracking?.scoreMin ?? null,
            scoreMax: isFreshAttempt ? null : existingTracking?.scoreMax ?? null,
            lessonLocation: nextLessonLocation,
            suspendData: nextSuspendData,
            sessionTime: nextSessionTime,
            totalTime: nextTotalTime,
            attempts: nextAttempts,
            lastAccessed: new Date(),
            interactions: isFreshAttempt
              ? []
              : mergeScormTrackingInteractions(existingTracking?.interactions || [], []),
          },
        },
        {
          new: true,
          upsert: true,
          runValidators: true,
        }
      ),
    ]);

    return res.status(200).send({
      status: "success",
      message: "SCORM progress initialized successfully",
      data: serializeCourseProgress(progressDoc),
    });
  } catch (err: any) {
    next(err);
  }
};

export const commitScormTrackingService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const courseId = normalizeObjectId(req.body.courseId, "courseId");
    const { sectionContext } = await resolveTrackingSectionContext(courseId, req.body.moduleId, req.body.sectionId);

    if (sectionContext) {
      return upsertSectionTrackingState(req, res, next, "commit", sectionContext);
    }

    return upsertCourseTrackingState(req, res, next, "commit");
  } catch (err: any) {
    next(err);
  }
};

export const finishScormTrackingService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const courseId = normalizeObjectId(req.body.courseId, "courseId");
    const { sectionContext } = await resolveTrackingSectionContext(courseId, req.body.moduleId, req.body.sectionId);

    if (sectionContext) {
      return upsertSectionTrackingState(req, res, next, "finish", sectionContext);
    }

    return upsertCourseTrackingState(req, res, next, "finish");
  } catch (err: any) {
    next(err);
  }
};

export async function reEnrichScormTrackingAttempt(trackingId: string) {
  const normalizedTrackingId = normalizeObjectId(trackingId, "trackingId");
  const trackingDoc: any = await ScormTracking.findById(normalizedTrackingId);

  if (!trackingDoc) {
    throw generateError("SCORM tracking record not found", 404);
  }

  const course: any = await Course.findById(trackingDoc.courseId).select("scormFilePath curriculum title").lean();
  if (!course) {
    throw generateError("Course not found", 404);
  }

  let sectionContext: NonNullable<TrackingSectionContext> | null = null;
  if (normalizeString(trackingDoc.moduleId) && normalizeString(trackingDoc.sectionId)) {
    try {
      sectionContext = findCourseSectionStructure(
        course,
        normalizeString(trackingDoc.moduleId),
        normalizeString(trackingDoc.sectionId)
      );
    } catch (error) {
      console.warn("[ScormTracking] Failed to resolve section context for re-enrichment", {
        trackingId: normalizedTrackingId,
        moduleId: normalizeString(trackingDoc.moduleId),
        sectionId: normalizeString(trackingDoc.sectionId),
      });
    }
  }

  const scormPackageId = extractScormPackageIdFromSectionContext(
    sectionContext
      ? {
          previewUrl: sectionContext.previewUrl,
          resourceUrl: sectionContext.previewUrl,
        }
      : {
          scormFilePath: normalizeString(course?.scormFilePath),
          resourceUrl: normalizeString(course?.scormFilePath),
        }
  );

  if (!scormPackageId) {
    logMissingScormPackageId({
      trackingId: normalizedTrackingId,
      courseId: String(trackingDoc.courseId),
      moduleId: normalizeString(trackingDoc.moduleId),
      sectionId: normalizeString(trackingDoc.sectionId),
      scormFilePath: normalizeString(course?.scormFilePath),
      previewUrl: normalizeString(sectionContext?.previewUrl),
    });

    return {
      trackingId: normalizedTrackingId,
      updated: false,
      reason: "missing_scorm_package_id",
    };
  }

  const enrichedInteractions = await enrichInteractionWithQuestionBank({
    interactions: Array.isArray(trackingDoc.interactions) ? trackingDoc.interactions : [],
    scormPackageId,
    courseId: String(trackingDoc.courseId),
    moduleId: normalizeString(trackingDoc.moduleId),
    sectionId: normalizeString(trackingDoc.sectionId),
  });

  trackingDoc.interactions = mergeScormTrackingInteractions(
    trackingDoc.interactions || [],
    enrichedInteractions as any
  ) as any;
  await trackingDoc.save();

  return {
    trackingId: normalizedTrackingId,
    updated: true,
    scormPackageId,
    interactionCount: Array.isArray(trackingDoc.interactions) ? trackingDoc.interactions.length : 0,
  };
}

export const updateSectionProgressService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = resolveProgressUserId(req, req.body.userId);
    const courseId = normalizeObjectId(req.body.courseId, "courseId");
    const requestedStatus = normalizeString(req.body.status).toLowerCase();
    const moduleId = normalizeString(req.body.moduleId);
    const sectionId = normalizeString(req.body.sectionId);
    const startOver = Boolean(req.body.startOver);

    if (requestedStatus !== "in_progress" && requestedStatus !== "completed") {
      throw generateError("status must be either in_progress or completed", 422);
    }

    await assertEnrollmentAccess(userId, courseId, req);

    const course = await Course.findById(courseId).select("curriculum").lean();
    if (!course) {
      throw generateError("Course not found", 404);
    }

    const sectionContext = findCourseSectionStructure(course, moduleId, sectionId);
    if (!sectionContext) {
      throw generateError("Invalid course section reference", 400);
    }

    const progressQuery = {
      userId: new mongoose.Types.ObjectId(userId),
      courseId: new mongoose.Types.ObjectId(courseId),
      moduleId: sectionContext.moduleId,
      sectionId: sectionContext.sectionId,
    };

    const existingProgress = await UserSectionProgress.findOne(progressQuery).lean();

    // --- Start Over logic ---
    if (startOver) {
      const nextAttempts = Math.max(Number(existingProgress?.attempts || 1) + 1, 1);
      const [progressDoc] = await Promise.all([
        UserSectionProgress.findOneAndUpdate(
          progressQuery,
          {
            $set: {
              lessonStatus: "not_attempted",
              completionStatus: "",
              successStatus: "",
              progressMeasure: null,
              isCompleted: false,
              completedAt: null,
              progress: 0,
              score: null,
              scoreRaw: null,
              scoreScaled: null,
              scoreMin: null,
              scoreMax: null,
              currentTime: 0,
              lessonLocation: "",
              suspendData: "",
              sessionTime: DEFAULT_SCORM_TIME,
              attempts: nextAttempts,
              lastAccessed: new Date(),
            },
          },
          { new: true, upsert: true, runValidators: true }
        ),
        ScormTracking.findOneAndUpdate(
          progressQuery,
          {
            $set: {
              lessonStatus: "not_attempted",
              completionStatus: "",
              successStatus: "",
              progressMeasure: null,
              progress: 0,
              score: null,
              scoreRaw: null,
              scoreScaled: null,
              scoreMin: null,
              scoreMax: null,
              lessonLocation: "",
              suspendData: "",
              sessionTime: DEFAULT_SCORM_TIME,
              attempts: nextAttempts,
              lastAccessed: new Date(),
              interactions: [],
            },
          },
          { new: true, upsert: true, runValidators: true }
        ),
      ]);

      const aggregateResult = await syncAggregateCourseProgress({
        userId,
        courseId,
        allowRegression: true,
      });

      return res.status(200).send({
        status: "success",
        message: "Section progress reset for fresh attempt",
        data: {
          sectionProgress: serializeSectionProgress(progressDoc),
          courseProgress: aggregateResult?.course || null,
        },
      });
    }

    // --- Parse incoming video/content fields ---
    const incomingCurrentTime = req.body.currentTime !== undefined ? Number(req.body.currentTime) : undefined;
    const incomingDuration = req.body.duration !== undefined ? Number(req.body.duration) : undefined;
    const incomingProgress = req.body.progress !== undefined ? Number(req.body.progress) : undefined;
    const incomingLessonLocation = normalizeString(req.body.lessonLocation);
    const incomingContentType = normalizeString(req.body.contentType).toLowerCase();
    const validContentTypes = new Set(["scorm", "video", "document", "other"]);

    // --- Compute next state ---
    const nextIsCompleted = requestedStatus === "completed" || Boolean(existingProgress?.isCompleted);
    const nextLessonStatus = nextIsCompleted ? "completed" : "incomplete";

    let nextProgress: number;
    if (nextIsCompleted) {
      nextProgress = 100;
    } else if (incomingProgress !== undefined && Number.isFinite(incomingProgress)) {
      nextProgress = Math.max(
        Math.min(Math.round(incomingProgress), 99),
        Number(existingProgress?.progress || 0)
      );
    } else {
      nextProgress = Math.max(Number(existingProgress?.progress || 0), 5);
    }

    const nextCurrentTime = nextIsCompleted
      ? 0
      : (incomingCurrentTime !== undefined && Number.isFinite(incomingCurrentTime))
        ? incomingCurrentTime
        : Number(existingProgress?.currentTime || 0);

    const nextDuration = (incomingDuration !== undefined && Number.isFinite(incomingDuration) && incomingDuration > 0)
      ? incomingDuration
      : Number(existingProgress?.duration || 0);

    const nextLessonLocation = incomingLessonLocation || existingProgress?.lessonLocation || "";

    const nextContentType = validContentTypes.has(incomingContentType)
      ? incomingContentType
      : existingProgress?.contentType || "other";

    const progressDoc = await UserSectionProgress.findOneAndUpdate(
      progressQuery,
      {
        $set: {
          lessonStatus: nextLessonStatus,
          completionStatus: nextIsCompleted ? "completed" : "incomplete",
          successStatus: normalizeSuccessStatus(existingProgress?.successStatus) || "unknown",
          progressMeasure: nextProgress,
          isCompleted: nextIsCompleted,
          completedAt: nextIsCompleted ? existingProgress?.completedAt || new Date() : null,
          progress: nextProgress,
          currentTime: nextCurrentTime,
          duration: nextDuration,
          lessonLocation: nextLessonLocation,
          contentType: nextContentType,
          attempts: Math.max(Number(existingProgress?.attempts || 0), 1),
          lastAccessed: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    const aggregateResult = await syncAggregateCourseProgress({
      userId,
      courseId,
    });

    return res.status(200).send({
      status: "success",
      message: "Section progress updated successfully",
      data: {
        sectionProgress: serializeSectionProgress(progressDoc),
        courseProgress: aggregateResult?.course || null,
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const getScormProgressService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = resolveProgressUserId(req, req.query.userId);
    const courseId = normalizeObjectId(req.query.courseId, "courseId");
    const moduleId = normalizeString(req.query.moduleId);
    const sectionId = normalizeString(req.query.sectionId);

    await assertEnrollmentAccess(userId, courseId, req);

    if (sectionId) {
      const progressDoc = await UserSectionProgress.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
        moduleId,
        sectionId,
      }).lean();

      if (!progressDoc) {
        return res.status(200).send({
          status: "success",
          message: "SCORM progress fetched successfully",
          data: {
            userId,
            courseId,
            moduleId,
            sectionId,
            lessonStatus: "not_attempted",
            isCompleted: false,
            completedAt: null,
            progress: 0,
            score: null,
            lessonLocation: "",
            suspendData: "",
            sessionTime: DEFAULT_SCORM_TIME,
            totalTime: DEFAULT_SCORM_TIME,
            currentTime: 0,
            duration: 0,
            contentType: "other",
            attempts: 0,
            lastAccessed: null,
            createdAt: null,
            updatedAt: null,
          },
        });
      }

      return res.status(200).send({
        status: "success",
        message: "SCORM progress fetched successfully",
        data: serializeSectionProgress(progressDoc),
      });
    }

    const progressDoc = await UserCourseProgress.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      courseId: new mongoose.Types.ObjectId(courseId),
    }).lean();

    if (!progressDoc) {
      return res.status(200).send({
        status: "success",
        message: "SCORM progress fetched successfully",
        data: {
          userId,
          courseId,
          lessonStatus: "not_attempted",
          progress: 0,
          score: null,
          lessonLocation: "",
          suspendData: "",
          sessionTime: DEFAULT_SCORM_TIME,
          totalTime: DEFAULT_SCORM_TIME,
          attempts: 0,
          lastAccessed: null,
          createdAt: null,
          updatedAt: null,
        },
      });
    }

    return res.status(200).send({
      status: "success",
      message: "SCORM progress fetched successfully",
      data: serializeCourseProgress(progressDoc),
    });
  } catch (err: any) {
    next(err);
  }
};

export const getMyScormAnswersService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = resolveProgressUserId(req, req.query.userId);
    const courseId = normalizeObjectId(req.query.courseId, "courseId");
    const sectionId = normalizeString(req.query.sectionId);

    await assertEnrollmentAccess(userId, courseId, req);

    const trackingQuery: any = {
      userId: new mongoose.Types.ObjectId(userId),
      courseId: new mongoose.Types.ObjectId(courseId),
    };
    const sectionProgressQuery: any = {
      userId: new mongoose.Types.ObjectId(userId),
      courseId: new mongoose.Types.ObjectId(courseId),
    };

    if (sectionId) {
      trackingQuery.sectionId = sectionId;
      sectionProgressQuery.sectionId = sectionId;
    }

    const [trackingDocs, sectionProgressDocs, courseProgressDoc, course] = await Promise.all([
      ScormTracking.find(trackingQuery)
        .select([
          "_id",
          "userId",
          "courseId",
          "moduleId",
          "sectionId",
          "lessonStatus",
          "completionStatus",
          "successStatus",
          "progressMeasure",
          "progress",
          "score",
          "scoreRaw",
          "scoreScaled",
          "scoreMin",
          "scoreMax",
          "lessonLocation",
          "suspendData",
          "decoded_suspend_data",
          "totalTime",
          "attempts",
          "lastAccessed",
          "createdAt",
          "updatedAt",
          "interactions._id",
          "interactions.index",
          "interactions.questionNumber",
          "interactions.id",
          "interactions.type",
          "interactions.question",
          "interactions.questionTitle",
          "interactions.questionPrompt",
          "interactions.questionAssetPaths",
          "interactions.questionBankMatched",
          "interactions.learnerResponse",
          "interactions.learnerResponseRaw",
          "interactions.learnerResponseText",
          "interactions.correctResponses",
          "interactions.correctResponsesRaw",
          "interactions.correctResponseTexts",
          "interactions.result",
          "interactions.isCorrect",
          "interactions.score",
          "interactions.latency",
          "interactions.time",
          "interactions.attemptTimestamp",
          "interactions.maxMarks",
          "interactions.source",
          "interactions.review",
        ].join(" "))
        .populate("interactions.review.reviewedBy", "name email username")
        .sort({ updatedAt: -1 })
        .lean(),
      UserSectionProgress.find(sectionProgressQuery).lean(),
      sectionId
        ? Promise.resolve(null)
        : UserCourseProgress.findOne({
            userId: new mongoose.Types.ObjectId(userId),
            courseId: new mongoose.Types.ObjectId(courseId),
          }).lean(),
      Course.findById(courseId).select("title curriculum").lean(),
    ]);
    const structureLookup = course ? buildCourseStructureLookup(course) : new Map();

    const courseQuizAnswerSections = await getCourseQuizAnswerSectionsForUser({ userId, courseId });
    const answerSectionMap = new Map<string, any>();
    const legacyCourseProgress = courseProgressDoc
      ? {
          ...courseProgressDoc,
          moduleId: COURSE_LEVEL_MODULE_ID,
          sectionId: COURSE_LEVEL_SECTION_ID,
        }
      : null;

    const appendAnswerSection = (trackingDoc: any) => {
      const moduleId = normalizeString(trackingDoc.moduleId);
      const recordSectionId = normalizeString(trackingDoc.sectionId);
      const moduleMetadata = structureLookup.get(moduleId);
      const serializedSection = serializeScormTrackingRecord(trackingDoc, {
        courseTitle: course?.title || "",
        moduleTitle:
          moduleMetadata?.moduleTitle ||
          (moduleId === COURSE_LEVEL_MODULE_ID ? course?.title || "Course" : ""),
        sectionTitle:
          moduleMetadata?.sectionLookup.get(recordSectionId) ||
          (recordSectionId === COURSE_LEVEL_SECTION_ID ? "Course SCORM activity" : ""),
      });
      if (!serializedSection.interactions.length) {
        return;
      }

      const key = `${moduleId}:${recordSectionId}`;
      const existingSection = answerSectionMap.get(key);
      if (
        !existingSection ||
        serializedSection.interactions.length >= existingSection.interactions.length
      ) {
        answerSectionMap.set(key, serializedSection);
      }
    };
    [...sectionProgressDocs, ...trackingDocs].forEach(appendAnswerSection);
    if (!answerSectionMap.size && legacyCourseProgress) {
      appendAnswerSection(legacyCourseProgress);
    }

    return res.status(200).send({
      status: "success",
      message: "SCORM answers fetched successfully",
      data: [...answerSectionMap.values(), ...courseQuizAnswerSections],
    });
  } catch (err: any) {
    next(err);
  }
};
