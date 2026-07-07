import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import User from "../../schemas/User/User";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import ScormTracking from "../../schemas/course/ScormTracking";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import UserSectionProgress from "../../schemas/course/UserSectionProgress";
import { buildMergedEnrollmentSummary } from "../courseAccess/utils/enrollmentSources";
import { getActorContext, isManagerRole } from "../courseAccess/utils/accessControl";
import {
  buildCourseHierarchyProgress,
  buildCourseStructureLookup,
  normalizeObjectId,
  normalizeScore,
  normalizeString,
  serializeCourseHierarchyModules,
  stringifyId,
  syncAggregateCourseProgress,
} from "../scorm/scormTracking.helpers";
import {
  isReviewableInteraction,
  serializeScormTrackingRecord,
  summarizeScormTrackingInteractions,
} from "../scorm/scormAnswerReview.helpers";
import {
  getCourseQuizAnswerSectionsForUser,
  summarizeCourseQuizAttemptsForUser,
} from "../course/courseQuiz.service";

function averageNumbers(values: number[]) {
  if (!values.length) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 100) / 100;
}

function averageNullableNumbers(values: Array<number | null | undefined>) {
  const numericValues = values.filter((value): value is number => Number.isFinite(value));
  if (!numericValues.length) {
    return null;
  }

  return averageNumbers(numericValues);
}

async function getManagerUser(actorUserId: string) {
  const manager = await User.findById(actorUserId)
    .select("_id name email username role assignedManagers managers")
    .lean();

  if (!manager) {
    throw generateError("Manager account not found", 404);
  }

  if (!isManagerRole(manager.role)) {
    throw generateError("Only manager users can access this view", 403);
  }

  return manager;
}

async function getManagedLearners(manager: any) {
  const managerObjectId = new mongoose.Types.ObjectId(String(manager._id));
  const managerEmail = normalizeString(manager.email).toLowerCase();

  const query: any = {
    _id: { $ne: managerObjectId },
    deletedAt: { $exists: false },
    $or: [
      { assignedManagers: managerObjectId },
      { managers: { $elemMatch: { managerId: managerObjectId, status: "ASSIGNED" } } },
      managerEmail
        ? { managers: { $elemMatch: { managerEmail, status: "ASSIGNED" } } }
        : null,
    ].filter(Boolean),
  };

  return User.find(query)
    .select("_id name email username role department company managers assignedManagers")
    .sort({ name: 1, email: 1, username: 1 })
    .lean();
}

async function assertManagerLearnerAccess(actor: any, learnerIdValue: unknown) {
  const learnerId = normalizeObjectId(learnerIdValue, "learnerId");
  const manager = await getManagerUser(actor.userId);
  const managedLearners = await getManagedLearners(manager);
  const learner = managedLearners.find((entry: any) => stringifyId(entry._id) === learnerId);

  if (!learner) {
    throw generateError("You are not assigned to this learner", 403);
  }

  return {
    manager,
    learner,
  };
}

function summarizeTrackingDocs(trackingDocs: any[]) {
  return trackingDocs.reduce(
    (summary, trackingDoc) => {
      const interactionSummary = summarizeScormTrackingInteractions(trackingDoc?.interactions || []);

      return {
        total: summary.total + interactionSummary.totalQuestions,
        pending: summary.pending + interactionSummary.pendingReviewCount,
        reviewed: summary.reviewed + interactionSummary.reviewedCount,
      };
    },
    { total: 0, pending: 0, reviewed: 0 }
  );
}

export const getManagerLearnersService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    const requestedManagerId = normalizeString(req.query.managerId || "");

    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    if (requestedManagerId && requestedManagerId !== actor.userId) {
      throw generateError("Managers can only access their own learner list", 403);
    }

    const manager = await getManagerUser(actor.userId);
    const learners = await getManagedLearners(manager);

    const learnerIds = learners.map((learner: any) => learner._id);
    const enrollments = learnerIds.length
      ? await CourseEnrollment.find({ userId: { $in: learnerIds } }).lean()
      : [];
    const courseProgressDocs = learnerIds.length
      ? await UserCourseProgress.find({ userId: { $in: learnerIds } }).lean()
      : [];

    const progressMap = new Map(
      courseProgressDocs.map((progressDoc: any) => [
        `${stringifyId(progressDoc.userId)}:${stringifyId(progressDoc.courseId)}`,
        progressDoc,
      ])
    );
    const enrollmentMap = new Map<string, any[]>();

    enrollments.forEach((enrollment: any) => {
      const key = stringifyId(enrollment.userId);
      const list = enrollmentMap.get(key) || [];
      list.push(enrollment);
      enrollmentMap.set(key, list);
    });

    const data = learners.map((learner: any) => {
      const learnerKey = stringifyId(learner._id);
      const learnerEnrollments = enrollmentMap.get(learnerKey) || [];
      const overallProgress = averageNumbers(
        learnerEnrollments.map((enrollment) => {
          if (enrollment.progressPercent !== undefined && enrollment.progressPercent !== null) {
            return Number(enrollment.progressPercent || 0);
          }

          return enrollment.status === "completed" ? 100 : enrollment.status === "in_progress" ? 50 : 0;
        })
      );
      const avgScore = averageNullableNumbers(
        learnerEnrollments.map((enrollment) => {
          const progressDoc = progressMap.get(`${learnerKey}:${stringifyId(enrollment.courseId)}`);
          return progressDoc?.score ?? null;
        })
      );

      return {
        _id: learnerKey,
        name: learner.name || learner.email || learner.username || "Learner",
        email: learner.email || "",
        username: learner.username || "",
        role: learner.role || "user",
        department: learner.department || "",
        overallProgress,
        avgScore,
        courseCount: learnerEnrollments.length,
        completedCourses: learnerEnrollments.filter((entry) => entry.status === "completed").length,
      };
    });

    return res.status(200).send({
      status: "success",
      message: "Managed learners fetched successfully",
      data,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getManagerLearnerProgressService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    const { learner } = await assertManagerLearnerAccess(actor, req.query.learnerId);

    const enrollments = await CourseEnrollment.find({
      userId: new mongoose.Types.ObjectId(String(learner._id)),
    })
      .populate("courseId")
      .sort({ updatedAt: -1 })
      .lean();

    const validEnrollments = enrollments.filter((enrollment: any) => enrollment.courseId);
    const courseIds = validEnrollments.map((enrollment: any) => enrollment.courseId?._id || enrollment.courseId);

    const [courseProgressDocs, sectionProgressDocs, trackingDocs, courseQuizSummaryMap] = await Promise.all([
      courseIds.length
        ? UserCourseProgress.find({
            userId: new mongoose.Types.ObjectId(String(learner._id)),
            courseId: { $in: courseIds },
          }).lean()
        : [],
      courseIds.length
        ? UserSectionProgress.find({
            userId: new mongoose.Types.ObjectId(String(learner._id)),
            courseId: { $in: courseIds },
          }).lean()
        : [],
      courseIds.length
        ? ScormTracking.find({
            userId: new mongoose.Types.ObjectId(String(learner._id)),
            courseId: { $in: courseIds },
            "interactions.0": { $exists: true },
          }).lean()
        : [],
      summarizeCourseQuizAttemptsForUser({
        userId: stringifyId(learner._id),
        courseIds: courseIds.map((courseId: any) => stringifyId(courseId)),
      }),
    ]);

    const courseProgressMap = new Map<string, any>(
      courseProgressDocs.map((entry: any) => [stringifyId(entry.courseId), entry] as [string, any])
    );
    const sectionProgressMap = new Map<string, any[]>();
    const trackingMap = new Map<string, any[]>();

    sectionProgressDocs.forEach((entry: any) => {
      const key = stringifyId(entry.courseId);
      const list = sectionProgressMap.get(key) || [];
      list.push(entry);
      sectionProgressMap.set(key, list);
    });

    trackingDocs.forEach((entry: any) => {
      const key = stringifyId(entry.courseId);
      const list = trackingMap.get(key) || [];
      list.push(entry);
      trackingMap.set(key, list);
    });

    const courses = validEnrollments.map((enrollment: any) => {
      const course = enrollment.courseId as any;
      const courseId = stringifyId(course._id);
      const merged = buildMergedEnrollmentSummary(enrollment);
      const hierarchy = buildCourseHierarchyProgress({
        course,
        userId: stringifyId(learner._id),
        courseId,
        sectionProgressDocs: sectionProgressMap.get(courseId) || [],
        courseProgressDoc: courseProgressMap.get(courseId) || null,
      });
      const courseTrackingDocs = trackingMap.get(courseId) || [];
      const answerSummary = summarizeTrackingDocs(courseTrackingDocs);
      const courseQuizSummary = courseQuizSummaryMap.get(courseId) || { total: 0, pending: 0, reviewed: 0 };

      return {
        courseId,
        title: course.title || "",
        thumbnailUrl: course.thumbnailUrl || "",
        description: course.description || null,
        progress: hierarchy.course.progress,
        score: hierarchy.course.score,
        attempts: hierarchy.course.attempts,
        lessonStatus: hierarchy.course.lessonStatus,
        totalTime: hierarchy.course.totalTime,
        lastAccessed: hierarchy.course.lastAccessed,
        status: merged.status,
        validTill: merged.validTill,
        visibilityStatus: merged.visibilityStatus,
        answerSummary: {
          total: answerSummary.total + courseQuizSummary.total,
          pending: answerSummary.pending + courseQuizSummary.pending,
          reviewed: answerSummary.reviewed + courseQuizSummary.reviewed,
        },
        modules: serializeCourseHierarchyModules(hierarchy.modules),
      };
    });

    return res.status(200).send({
      status: "success",
      message: "Learner progress fetched successfully",
      data: {
        learner: {
          _id: stringifyId(learner._id),
          name: learner.name || learner.email || learner.username || "Learner",
          email: learner.email || "",
          username: learner.username || "",
          role: learner.role || "user",
          department: learner.department || "",
        },
        summary: {
          overallProgress: averageNumbers(courses.map((course) => Number(course.progress || 0))),
          avgScore: averageNullableNumbers(courses.map((course) => course.score)),
          courseCount: courses.length,
        },
        courses,
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const getManagerLearnerAnswersService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    const { learner } = await assertManagerLearnerAccess(actor, req.query.learnerId);
    const courseId = normalizeString(req.query.courseId);

    const trackingQuery: any = {
      userId: new mongoose.Types.ObjectId(String(learner._id)),
      "interactions.0": { $exists: true },
    };

    if (courseId) {
      trackingQuery.courseId = new mongoose.Types.ObjectId(normalizeObjectId(courseId, "courseId"));
    }

    const trackingDocs = await ScormTracking.find(trackingQuery)
      .populate("interactions.review.reviewedBy", "name email username")
      .sort({ updatedAt: -1 })
      .lean();
    const courseQuizAnswerSections = await getCourseQuizAnswerSectionsForUser({
      userId: stringifyId(learner._id),
      ...(courseId ? { courseId } : {}),
    });

    const courseIds = Array.from(
      new Set(trackingDocs.map((entry: any) => stringifyId(entry.courseId)).filter(Boolean))
    );
    const courses = courseIds.length
      ? await mongoose
          .model("Course")
          .find({ _id: { $in: courseIds.map((value) => new mongoose.Types.ObjectId(value)) } })
          .select("title curriculum")
          .lean()
      : [];

    const courseLookup = new Map<string, any>(
      courses.map((course: any) => [stringifyId(course._id), course] as [string, any])
    );

    const data = trackingDocs.map((trackingDoc: any) => {
      const course = courseLookup.get(stringifyId(trackingDoc.courseId));
      const structureLookup = course ? buildCourseStructureLookup(course) : new Map();
      const moduleMetadata = structureLookup.get(normalizeString(trackingDoc.moduleId));

      return serializeScormTrackingRecord(trackingDoc, {
        courseTitle: course?.title || "",
        moduleTitle: moduleMetadata?.moduleTitle || "",
        sectionTitle: moduleMetadata?.sectionLookup.get(normalizeString(trackingDoc.sectionId)) || "",
      });
    });

    return res.status(200).send({
      status: "success",
      message: "Learner answers fetched successfully",
      data: [...data, ...courseQuizAnswerSections],
    });
  } catch (err: any) {
    next(err);
  }
};

export const reviewManagerAnswerService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const actor = getActorContext(req);
    if (!actor.userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    const manager = await getManagerUser(actor.userId);
    const trackingId = normalizeObjectId(req.body.trackingId, "trackingId");
    const interactionId = normalizeObjectId(req.body.interactionId, "interactionId");
    const marks = normalizeScore(req.body.marks);

    if (marks === null || marks < 0 || marks > 10) {
      throw generateError("marks must be a number between 0 and 10", 422);
    }

    const trackingDoc: any = await ScormTracking.findById(trackingId);
    if (!trackingDoc) {
      throw generateError("SCORM tracking record not found", 404);
    }

    await assertManagerLearnerAccess(actor, trackingDoc.userId);

    const interaction = trackingDoc.interactions?.id?.(interactionId);
    if (!interaction) {
      throw generateError("Tracked interaction not found", 404);
    }

    if (!isReviewableInteraction(interaction)) {
      throw generateError("Only input-style answers can be manually reviewed", 422);
    }

    interaction.review = {
      status: "reviewed",
      evaluation: marks >= 10 ? "correct" : marks <= 0 ? "incorrect" : undefined,
      marks,
      reviewedBy: new mongoose.Types.ObjectId(String(manager._id)),
      reviewedAt: new Date(),
    };

    await trackingDoc.save();
    
    // Natively sync the SCORM section score based on updated interactions
    const summary = summarizeScormTrackingInteractions(trackingDoc.interactions);
    let computedScore: number | null = trackingDoc.score ?? null;
    if (summary.possibleMarks > 0) {
       computedScore = Math.min(
         100,
         Math.max(0, Math.round((summary.awardedMarks / summary.possibleMarks) * 100))
       );
    }

    if (computedScore !== null) {
        await UserSectionProgress.findOneAndUpdate(
          {
            userId: trackingDoc.userId,
            courseId: trackingDoc.courseId,
            moduleId: trackingDoc.moduleId,
            sectionId: trackingDoc.sectionId
          },
          { $set: { score: computedScore } }
        );
        await syncAggregateCourseProgress({ userId: trackingDoc.userId, courseId: trackingDoc.courseId });
    }

    await trackingDoc.populate("interactions.review.reviewedBy", "name email username");

    const course: any = await mongoose
      .model("Course")
      .findById(trackingDoc.courseId)
      .select("title curriculum")
      .lean();
    const structureLookup = course ? buildCourseStructureLookup(course) : new Map();
    const moduleMetadata = structureLookup.get(normalizeString(trackingDoc.moduleId));

    return res.status(200).send({
      status: "success",
      message: "Answer reviewed successfully",
      data: serializeScormTrackingRecord(trackingDoc.toObject(), {
        courseTitle: course?.title || "",
        moduleTitle: moduleMetadata?.moduleTitle || "",
        sectionTitle: moduleMetadata?.sectionLookup.get(normalizeString(trackingDoc.sectionId)) || "",
      }),
    });
  } catch (err: any) {
    next(err);
  }
};
