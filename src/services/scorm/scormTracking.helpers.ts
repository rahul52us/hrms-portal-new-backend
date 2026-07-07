import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import Course from "../../schemas/course/Course";
import CourseEnrollment from "../../schemas/course/CourseEnrollment";
import UserCourseProgress, { ScormLessonStatus } from "../../schemas/course/UserCourseProgress";
import UserSectionProgress from "../../schemas/course/UserSectionProgress";
import { tryIssueCertificateForCompletedCourse } from "../certificate/certificate.service";

const LZString: any = require("lz-string");

export type ScormInteractionPayload = {
  index?: number;
  id?: string;
  type?: string;
  result?: string;
  studentResponse?: string;
  learnerResponse?: string;
  correctResponses?: string[];
  weighting?: number | null;
  rawData?: Record<string, any>;
};

export type CourseStructureSection = {
  moduleId: string;
  moduleOrder: number;
  moduleTitle: string;
  sectionId: string;
  sectionOrder: number;
  sectionTitle: string;
  previewUrl: string;
  slideCount: number | null;
  questionMetadata: any[];
};

export type CourseStructureModule = {
  moduleId: string;
  moduleOrder: number;
  moduleTitle: string;
  sections: CourseStructureSection[];
};

export const DEFAULT_SCORM_TIME = "00:00:00";
export const COMPLETED_STATUSES = new Set<ScormLessonStatus>(["completed", "passed"]);
export const SCORM_SECTION_AUTOCOMPLETE_THRESHOLD = 98;
export const ALLOWED_STATUSES = new Set<ScormLessonStatus>([
  "not_attempted",
  "incomplete",
  "completed",
  "passed",
  "failed",
  "browsed",
]);
export const PRIVILEGED_PROGRESS_ROLES = new Set(["superadmin", "admin", "departmenthead"]);
const SCORM_2004_COMPLETION_STATUSES = new Set(["completed", "incomplete", "not attempted", "unknown"]);
const SCORM_2004_SUCCESS_STATUSES = new Set(["passed", "failed", "unknown"]);

function normalizeKeySegment(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function stringifyId(value: any) {
  return value ? String(value) : "";
}

export function normalizeObjectId(value: unknown, fieldName: string) {
  const normalizedValue = String(value || "").trim();
  if (!mongoose.Types.ObjectId.isValid(normalizedValue)) {
    throw generateError(`Invalid ${fieldName}`, 400);
  }

  return normalizedValue;
}

export function normalizeString(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeScore(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

export function normalizeLessonStatus(value: unknown, fallback: ScormLessonStatus = "not_attempted") {
  const normalizedValue = normalizeString(value).toLowerCase() as ScormLessonStatus;
  return ALLOWED_STATUSES.has(normalizedValue) ? normalizedValue : fallback;
}

export function normalizeCompletionStatus(value: unknown) {
  const normalizedValue = normalizeString(value)
    .toLowerCase()
    .replace(/_/g, " ");

  return SCORM_2004_COMPLETION_STATUSES.has(normalizedValue) ? normalizedValue : "";
}

export function normalizeSuccessStatus(value: unknown) {
  const normalizedValue = normalizeString(value).toLowerCase();
  return SCORM_2004_SUCCESS_STATUSES.has(normalizedValue) ? normalizedValue : "";
}

export function normalizeProgressMeasure(value: unknown) {
  const numericValue = normalizeScore(value);
  if (numericValue === null) {
    return null;
  }

  const normalizedValue = numericValue > 1 ? numericValue : numericValue * 100;
  return Math.max(0, Math.min(100, Math.round(normalizedValue * 100) / 100));
}

export function resolveScormLessonStatus(options: {
  lessonStatus?: unknown;
  completionStatus?: unknown;
  successStatus?: unknown;
  fallback?: ScormLessonStatus;
}) {
  const explicitLessonStatus = normalizeString(options.lessonStatus).toLowerCase() as ScormLessonStatus;
  if (ALLOWED_STATUSES.has(explicitLessonStatus)) {
    return explicitLessonStatus;
  }

  const successStatus = normalizeSuccessStatus(options.successStatus);
  const completionStatus = normalizeCompletionStatus(options.completionStatus);

  if (successStatus === "passed") {
    return "passed" as ScormLessonStatus;
  }

  if (successStatus === "failed") {
    return "failed" as ScormLessonStatus;
  }

  if (completionStatus === "completed") {
    return "completed" as ScormLessonStatus;
  }

  if (completionStatus === "incomplete") {
    return "incomplete" as ScormLessonStatus;
  }

  if (completionStatus === "not attempted") {
    return "not_attempted" as ScormLessonStatus;
  }

  return normalizeLessonStatus(options.fallback, "not_attempted");
}

export function parseScorm12Time(value: string | null | undefined) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return null;
  }

  const match = normalizedValue.match(/^(\d{1,4}):([0-5]?\d):([0-5]?\d)(?:\.(\d{1,2}))?$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const centiseconds = Number((match[4] || "").padEnd(2, "0").slice(0, 2) || "0");

  return ((((hours * 60) + minutes) * 60) + seconds) * 100 + centiseconds;
}

export function parseScorm2004Time(value: string | null | undefined) {
  const normalizedValue = normalizeString(value).toUpperCase();
  if (!normalizedValue) {
    return null;
  }

  const match = normalizedValue.match(
    /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!match) {
    return null;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;

  return Number.isFinite(totalSeconds) ? Math.round(totalSeconds * 100) : null;
}

export function formatScorm12Time(totalCentiseconds: number | null | undefined) {
  if (!Number.isFinite(totalCentiseconds) || totalCentiseconds === null || totalCentiseconds === undefined) {
    return DEFAULT_SCORM_TIME;
  }

  const safeValue = Math.max(0, Math.floor(totalCentiseconds));
  const hours = Math.floor(safeValue / 360000);
  const remainderAfterHours = safeValue % 360000;
  const minutes = Math.floor(remainderAfterHours / 6000);
  const remainderAfterMinutes = remainderAfterHours % 6000;
  const seconds = Math.floor(remainderAfterMinutes / 100);
  const centiseconds = remainderAfterMinutes % 100;

  const baseValue = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return centiseconds > 0 ? `${baseValue}.${String(centiseconds).padStart(2, "0")}` : baseValue;
}

export function normalizeScorm12Time(value: unknown, fallback = DEFAULT_SCORM_TIME) {
  const normalizedValue = normalizeString(value);
  const parsedValue = parseScorm12Time(normalizedValue) ?? parseScorm2004Time(normalizedValue);
  return parsedValue === null ? fallback : formatScorm12Time(parsedValue);
}

type SlidePositionMode = "zero_based" | "one_based" | "unknown";

type SlidePositionMatch = {
  position: number;
  mode: SlidePositionMode;
};

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function buildSuspendDataCandidates(suspendData: string | null | undefined) {
  const normalizedSuspendData = normalizeString(suspendData);
  if (!normalizedSuspendData) {
    return [];
  }

  return [
    normalizedSuspendData,
    (() => {
      try {
        return decodeURIComponent(normalizedSuspendData);
      } catch (error) {
        return "";
      }
    })(),
    LZString.decompressFromEncodedURIComponent(normalizedSuspendData) || "",
    LZString.decompressFromBase64(normalizedSuspendData) || "",
    LZString.decompress(normalizedSuspendData) || "",
  ].filter(Boolean);
}

function buildSuspendDataPayloads(suspendData: string | null | undefined) {
  return buildSuspendDataCandidates(suspendData)
    .map((candidate) => safeJsonParse(candidate))
    .filter((payload) => payload !== null);
}

function readInteger(value: unknown, options?: { allowZero?: boolean }) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue)) {
    return null;
  }

  if (options?.allowZero) {
    return numericValue >= 0 ? numericValue : null;
  }

  return numericValue > 0 ? numericValue : null;
}

function findNumericValueByKey(
  rootValue: unknown,
  keyMatchers: Array<{ pattern: RegExp; mode?: SlidePositionMode }>
) {
  const queue: unknown[] = [rootValue];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const currentValue = queue.shift();
    if (!currentValue || visited.has(currentValue)) {
      continue;
    }

    if (typeof currentValue !== "object") {
      continue;
    }

    visited.add(currentValue);

    if (Array.isArray(currentValue)) {
      currentValue.forEach((entry) => queue.push(entry));
      continue;
    }

    for (const [key, value] of Object.entries(currentValue)) {
      const keyMatch = keyMatchers.find((matcher) => matcher.pattern.test(key));
      if (keyMatch) {
        const numericValue = readInteger(value, { allowZero: true });
        if (numericValue !== null) {
          return {
            value: numericValue,
            mode: keyMatch.mode || "unknown",
          };
        }
      }

      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

function resolveNumericValueByKey(
  rootValue: unknown,
  keyMatchers: Array<{ pattern: RegExp; mode?: SlidePositionMode }>
): SlidePositionMatch | null {
  const match = findNumericValueByKey(rootValue, keyMatchers);
  if (!match) {
    return null;
  }

  return {
    position: Number(match.value),
    mode: match.mode || "unknown",
  };
}

function extractPositiveIntegerFromText(text: string, patterns: RegExp[]) {
  const normalizedText = normalizeString(text);
  if (!normalizedText) {
    return null;
  }

  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    const numericValue = readInteger(match?.[1], { allowZero: false });
    if (numericValue !== null) {
      return numericValue;
    }
  }

  return null;
}

function extractTotalSlidesFromSuspendData(suspendData: string | null | undefined) {
  const payloads = buildSuspendDataPayloads(suspendData);
  const totalSlideMatchers = [
    { pattern: /^slidesToView$/i },
    { pattern: /^totalSlides?$/i },
    { pattern: /^slideCount$/i },
    { pattern: /^totalPages?$/i },
    { pattern: /^pageCount$/i },
  ];

  for (const payload of payloads) {
    const directMatch = resolveNumericValueByKey(payload, totalSlideMatchers);
    if (directMatch?.position !== undefined) {
      return Math.max(1, directMatch.position);
    }
  }

  return extractPositiveIntegerFromText(normalizeString(buildSuspendDataCandidates(suspendData).join(" ")), [
    /["']slidesToView["']\s*:\s*(\d+)/i,
    /\bslidesToView\s*[:=]\s*(\d+)/i,
    /["']totalSlides["']\s*:\s*(\d+)/i,
    /\btotalSlides?\s*[:=]\s*(\d+)/i,
    /["']slideCount["']\s*:\s*(\d+)/i,
    /\bslideCount\s*[:=]\s*(\d+)/i,
  ]);
}

function extractSlidePositionFromSuspendData(suspendData: string | null | undefined): SlidePositionMatch | null {
  const payloads = buildSuspendDataPayloads(suspendData);
  const positionMatchers = [
    { pattern: /^slideIndex$/i, mode: "zero_based" as const },
    { pattern: /^currentSlideIndex$/i, mode: "zero_based" as const },
    { pattern: /^resumeSlideIndex$/i, mode: "zero_based" as const },
    { pattern: /^pageIndex$/i, mode: "zero_based" as const },
    { pattern: /^currentPageIndex$/i, mode: "zero_based" as const },
    { pattern: /^slideNumber$/i, mode: "one_based" as const },
    { pattern: /^currentSlideNumber$/i, mode: "one_based" as const },
    { pattern: /^pageNumber$/i, mode: "one_based" as const },
    { pattern: /^currentPageNumber$/i, mode: "one_based" as const },
    { pattern: /^currentSlide$/i, mode: "unknown" as const },
    { pattern: /^currentPage$/i, mode: "unknown" as const },
  ];

  for (const payload of payloads) {
    const directMatch = resolveNumericValueByKey(payload, positionMatchers);
    if (directMatch) {
      return directMatch;
    }
  }

  const candidateText = buildSuspendDataCandidates(suspendData).join(" ");
  const textPatterns = [
    { pattern: /["']slideIndex["']\s*:\s*(\d+)/i, mode: "zero_based" as const },
    { pattern: /["']currentSlideIndex["']\s*:\s*(\d+)/i, mode: "zero_based" as const },
    { pattern: /["']resumeSlideIndex["']\s*:\s*(\d+)/i, mode: "zero_based" as const },
    { pattern: /["']pageIndex["']\s*:\s*(\d+)/i, mode: "zero_based" as const },
    { pattern: /["']slideNumber["']\s*:\s*(\d+)/i, mode: "one_based" as const },
    { pattern: /["']currentSlideNumber["']\s*:\s*(\d+)/i, mode: "one_based" as const },
    { pattern: /["']currentSlide["']\s*:\s*(\d+)/i, mode: "unknown" as const },
  ];

  for (const { pattern, mode } of textPatterns) {
    const match = candidateText.match(pattern);
    const numericValue = readInteger(match?.[1], { allowZero: true });
    if (numericValue !== null) {
      return {
        position: numericValue,
        mode,
      };
    }
  }

  return null;
}

function extractTotalSlidesFromLessonLocation(lessonLocation: string | null | undefined) {
  const normalizedLocation = normalizeString(lessonLocation);
  if (!normalizedLocation) {
    return null;
  }

  const ratioMatch = normalizedLocation.match(/(?:slide|page|screen)?\s*(\d+)\s*(?:\/|of)\s*(\d+)/i);
  return readInteger(ratioMatch?.[2], { allowZero: false });
}

function extractSlideProgressFromRatio(value: string | null | undefined) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return null;
  }

  const ratioMatch = normalizedValue.match(/(?:slide|page|screen)?\s*(\d+)\s*(?:\/|of)\s*(\d+)/i);
  const currentValue = readInteger(ratioMatch?.[1], { allowZero: false });
  const totalValue = readInteger(ratioMatch?.[2], { allowZero: false });

  if (currentValue === null || totalValue === null || totalValue <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, (currentValue / totalValue) * 100));
}

function resolvePositionBasedProgress(
  position: number,
  totalSlides: number,
  mode: SlidePositionMode,
  hintProgress: number | null
) {
  if (!Number.isFinite(position) || totalSlides <= 0) {
    return null;
  }

  const clampedPosition = Math.max(0, position);
  const candidateProgressValues =
    mode === "zero_based"
      ? [((Math.min(clampedPosition, totalSlides - 1) + 1) / totalSlides) * 100]
      : mode === "one_based"
        ? [(Math.min(Math.max(clampedPosition, 1), totalSlides) / totalSlides) * 100]
        : [
            ((Math.min(clampedPosition, totalSlides - 1) + 1) / totalSlides) * 100,
            (Math.min(Math.max(clampedPosition, 1), totalSlides) / totalSlides) * 100,
          ];

  const resolvedValue =
    candidateProgressValues.length === 1
      ? candidateProgressValues[0]
      : hintProgress !== null && hintProgress > 0 && hintProgress < 100
        ? candidateProgressValues
            .slice()
            .sort((left, right) => Math.abs(left - hintProgress) - Math.abs(right - hintProgress))[0]
        : Math.max(...candidateProgressValues);

  return Math.max(0, Math.min(100, resolvedValue));
}

function extractProgressFromSuspendData(suspendData: string | null | undefined) {
  for (const candidate of buildSuspendDataCandidates(suspendData)) {
    const match = candidate.match(
      /("progress"\s*:\s*|progress\s*=\s*|"percentComplete"\s*:\s*|"completion"\s*:\s*|"progressMeasure"\s*:\s*)(\d+(\.\d+)?)/i
    );
    if (!match?.[2]) {
      continue;
    }

    const numericValue = Number(match[2]);
    if (!Number.isFinite(numericValue)) {
      continue;
    }

    return numericValue > 1 ? numericValue : numericValue * 100;
  }

  return null;
}

function extractProgressFromLessonLocation(lessonLocation: string | null | undefined) {
  const normalizedLocation = normalizeString(lessonLocation);
  if (!normalizedLocation) {
    return null;
  }

  const match = normalizedLocation.match(/^(\d+(\.\d+)?)%?$/);
  if (!match?.[1]) {
    return null;
  }

  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.max(0, Math.min(100, numericValue));
}

export function deriveProgress(lessonStatus: ScormLessonStatus, payload: {
  lessonLocation?: string;
  suspendData?: string;
  score?: number | null;
  scoreRaw?: number | null;
  scoreScaled?: number | null;
  scoreMin?: number | null;
  scoreMax?: number | null;
  totalTime?: string;
  sessionTime?: string;
  progressMeasure?: number | null;
  completionStatus?: string;
  successStatus?: string;
  slideCount?: number | null;
  interactions?: any[];
}) {
  if (COMPLETED_STATUSES.has(lessonStatus)) {
    return 100;
  }

  if (normalizeCompletionStatus(payload.completionStatus) === "completed") {
    return 100;
  }

  if (normalizeSuccessStatus(payload.successStatus) === "passed") {
    return 100;
  }

  let computedProgress = 0;

  const progressMeasure = normalizeProgressMeasure(payload.progressMeasure);
  if (progressMeasure !== null) {
    computedProgress = Math.max(computedProgress, progressMeasure);
  }

  const inferredSlideCount =
    readInteger(payload.slideCount, { allowZero: false }) ??
    extractTotalSlidesFromSuspendData(payload.suspendData) ??
    extractTotalSlidesFromLessonLocation(payload.lessonLocation);
  const progressHint = Math.max(computedProgress, 0) || null;
  const suspendDataSlidePosition = extractSlidePositionFromSuspendData(payload.suspendData);
  if (inferredSlideCount !== null && suspendDataSlidePosition) {
    const suspendDataSlideProgress = resolvePositionBasedProgress(
      suspendDataSlidePosition.position,
      inferredSlideCount,
      suspendDataSlidePosition.mode,
      progressHint
    );

    if (suspendDataSlideProgress !== null) {
      computedProgress = Math.max(computedProgress, Math.min(suspendDataSlideProgress, 99));
    }
  }

  const lessonLocationRatioProgress = extractSlideProgressFromRatio(payload.lessonLocation);
  if (lessonLocationRatioProgress !== null) {
    computedProgress = Math.max(computedProgress, Math.min(lessonLocationRatioProgress, 99));
  } else if (inferredSlideCount !== null) {
    const numericLessonLocation = normalizeString(payload.lessonLocation).match(/^(\d+)(?:\.\d+)?$/);
    const lessonLocationPosition = readInteger(numericLessonLocation?.[1], { allowZero: true });
    if (lessonLocationPosition !== null) {
      const lessonLocationSlideProgress = resolvePositionBasedProgress(
        lessonLocationPosition,
        inferredSlideCount,
        "unknown",
        progressHint
      );

      if (lessonLocationSlideProgress !== null) {
        computedProgress = Math.max(computedProgress, Math.min(lessonLocationSlideProgress, 99));
      }
    }
  }

  // Interaction-based progress: extract the highest slide number from interaction IDs
  // (e.g. "Slide18_Q_...") and compute position / totalSlides.
  // This handles iSpring and similar authoring tools that embed slide numbers in interaction IDs
  // but don't report progress through suspendData or lessonLocation.
  if (inferredSlideCount !== null && Array.isArray(payload.interactions) && payload.interactions.length > 0) {
    let maxSlideFromInteractions = 0;
    const slidePattern = /(?:^|[_\-])(?:slide|page|scene)(\d+)/i;
    for (const interaction of payload.interactions) {
      const interactionId = normalizeString(interaction?.id);
      if (!interactionId) continue;
      const match = interactionId.match(slidePattern);
      if (match?.[1]) {
        const slideNum = Number(match[1]);
        if (Number.isFinite(slideNum) && slideNum > maxSlideFromInteractions) {
          maxSlideFromInteractions = slideNum;
        }
      }
    }

    if (maxSlideFromInteractions > 0) {
      const interactionProgress = Math.min(
        Math.round((maxSlideFromInteractions / inferredSlideCount) * 100),
        99
      );
      computedProgress = Math.max(computedProgress, interactionProgress);
    }
  }

  const suspendDataProgress = extractProgressFromSuspendData(payload.suspendData);
  if (suspendDataProgress !== null) {
    computedProgress = Math.max(computedProgress, Math.min(suspendDataProgress, 99));
  }

  const lessonLocationProgress = extractProgressFromLessonLocation(payload.lessonLocation);
  if (lessonLocationProgress !== null) {
    computedProgress = Math.max(computedProgress, Math.min(lessonLocationProgress, 99));
  }

  if (computedProgress === 0 && payload.totalTime && payload.totalTime !== DEFAULT_SCORM_TIME) {
    computedProgress = 5; 
  }

  return Math.min(Math.round(computedProgress), 100);
}
export function mapLessonStatusToEnrollmentStatus(lessonStatus: ScormLessonStatus, progress: number) {
  if (progress >= 100) {
    return "completed";
  }

  if (COMPLETED_STATUSES.has(lessonStatus)) {
    return "completed";
  }

  if (progress > 0 || lessonStatus === "failed" || lessonStatus === "browsed" || lessonStatus === "incomplete") {
    return "in_progress";
  }

  return "not_started";
}

export function computeIncrementalSessionCentiseconds(previousSessionTime: string, nextSessionTime: string) {
  const previousValue = parseScorm12Time(previousSessionTime) || 0;
  const nextValue = parseScorm12Time(nextSessionTime);

  if (nextValue === null) {
    return 0;
  }

  return nextValue >= previousValue ? nextValue - previousValue : nextValue;
}

export function serializeCourseProgress(progressDoc: any) {
  const lessonStatus = normalizeLessonStatus(progressDoc.lessonStatus);
  const progress = COMPLETED_STATUSES.has(lessonStatus)
    ? 100
    : Math.max(0, Math.min(100, Number(progressDoc.progress || 0)));

  return {
    userId: stringifyId(progressDoc.userId),
    courseId: stringifyId(progressDoc.courseId),
    lessonStatus,
    completionStatus: normalizeCompletionStatus(progressDoc.completionStatus),
    successStatus: normalizeSuccessStatus(progressDoc.successStatus),
    progressMeasure: normalizeProgressMeasure(progressDoc.progressMeasure),
    progress,
    score: progressDoc.score ?? null,
    scoreRaw: progressDoc.scoreRaw ?? null,
    scoreScaled: progressDoc.scoreScaled ?? null,
    scoreMin: progressDoc.scoreMin ?? null,
    scoreMax: progressDoc.scoreMax ?? null,
    lessonLocation: progressDoc.lessonLocation || "",
    suspendData: progressDoc.suspendData || "",
    sessionTime: progressDoc.sessionTime || DEFAULT_SCORM_TIME,
    totalTime: progressDoc.totalTime || DEFAULT_SCORM_TIME,
    attempts: Number(progressDoc.attempts || 0),
    lastAccessed: progressDoc.lastAccessed || null,
    createdAt: progressDoc.createdAt || null,
    updatedAt: progressDoc.updatedAt || null,
  };
}

export function serializeSectionProgress(progressDoc: any) {
  const lessonStatus = normalizeLessonStatus(progressDoc.lessonStatus);
  const isCompleted = Boolean(
    progressDoc.isCompleted ||
    COMPLETED_STATUSES.has(lessonStatus) ||
    Number(progressDoc.progress || 0) >= 100
  );

  return {
    ...serializeCourseProgress(progressDoc),
    moduleId: normalizeString(progressDoc.moduleId),
    sectionId: normalizeString(progressDoc.sectionId),
    progress: isCompleted ? 100 : Math.max(0, Math.min(100, Number(progressDoc.progress || 0))),
    lessonStatus,
    isCompleted,
    completedAt: progressDoc.completedAt || null,
    currentTime: Number(progressDoc.currentTime || 0),
    duration: Number(progressDoc.duration || 0),
    contentType: progressDoc.contentType || "other",
  };
}

export function canAccessOtherUsersProgress(req: any) {
  const role = String(req.user?.role || req.bodyData?.role || "").toLowerCase();
  return PRIVILEGED_PROGRESS_ROLES.has(role);
}

export function hasPrivilegedScormAccess(req: any) {
  const role = String(req.user?.role || req.bodyData?.role || "").toLowerCase();
  return PRIVILEGED_PROGRESS_ROLES.has(role);
}

export function resolveProgressUserId(req: any, requestedUserId: unknown) {
  const authenticatedUserId = normalizeString(req.userId);

  if (!authenticatedUserId) {
    throw generateError("Authenticated user context is required", 401);
  }

  const resolvedUserId = normalizeObjectId(requestedUserId || authenticatedUserId, "userId");

  if (resolvedUserId !== authenticatedUserId && !canAccessOtherUsersProgress(req)) {
    throw generateError("You can only access your own SCORM progress", 403);
  }

  return resolvedUserId;
}

export async function assertEnrollmentAccess(userId: string, courseId: string, req?: any) {
  if (hasPrivilegedScormAccess(req)) {
    return null;
  }

  const enrollment = await CourseEnrollment.findOne({
    userId: new mongoose.Types.ObjectId(userId),
    courseId: new mongoose.Types.ObjectId(courseId),
  });

  if (!enrollment) {
    throw generateError("Course is not assigned to this user", 404);
  }

  return enrollment;
}

export async function syncEnrollmentProgress(options: {
  userId: string;
  courseId: string;
  lessonStatus: ScormLessonStatus;
  progress: number;
  allowRegression?: boolean;
}) {
  const enrollmentQuery = {
    userId: new mongoose.Types.ObjectId(options.userId),
    courseId: new mongoose.Types.ObjectId(options.courseId),
  };
  const existingEnrollment = await CourseEnrollment.findOne(enrollmentQuery)
    .select("status progressPercent")
    .lean();
  const existingCompleted = normalizeString(existingEnrollment?.status).toLowerCase() === "completed";
  const requestedStatus = mapLessonStatusToEnrollmentStatus(options.lessonStatus, options.progress);
  const nextStatus =
    existingCompleted && !options.allowRegression ? "completed" : requestedStatus;
  const nextProgress =
    existingCompleted && !options.allowRegression
      ? 100
      : options.allowRegression
        ? options.progress
        : Math.max(Number(existingEnrollment?.progressPercent || 0), options.progress);

  await CourseEnrollment.updateOne(
    enrollmentQuery,
    {
      $set: {
        status: nextStatus,
        progressPercent: nextProgress,
      },
    }
  );

  if (nextStatus === "completed") {
    tryIssueCertificateForCompletedCourse({
      userId: options.userId,
      courseId: options.courseId,
    }).catch((error) => {
      console.warn("[Certificates] Automatic issuance failed after course completion", error);
    });
  }
}

export function deriveModuleId(moduleRecord: any) {
  const moduleOrder = Number(moduleRecord?.order || 0);
  return `module-${moduleOrder}`;
}

export function deriveSectionId(moduleRecord: any, sectionRecord: any) {
  const moduleId = deriveModuleId(moduleRecord);
  const sectionOrder = Number(sectionRecord?.order || 0);
  const previewToken = normalizeKeySegment(sectionRecord?.content?.previewUrl);
  const titleToken = normalizeKeySegment(sectionRecord?.title);
  const suffix = previewToken || titleToken || `section-${sectionOrder}`;
  return `${moduleId}:section-${sectionOrder}-${suffix}`;
}

export function buildCourseStructure(course: any) {
  const modules = Array.isArray(course?.curriculum?.modules) ? course.curriculum.modules : [];

  return modules.map((moduleRecord: any) => {
    const moduleId = deriveModuleId(moduleRecord);
    const sections = Array.isArray(moduleRecord?.sections)
      ? moduleRecord.sections.map((sectionRecord: any) => ({
          moduleId,
          moduleOrder: Number(moduleRecord?.order || 0),
          moduleTitle: normalizeString(moduleRecord?.title) || `Module ${Number(moduleRecord?.order || 0) || 1}`,
          sectionId: deriveSectionId(moduleRecord, sectionRecord),
          sectionOrder: Number(sectionRecord?.order || 0),
          sectionTitle: normalizeString(sectionRecord?.title) || `Section ${Number(sectionRecord?.order || 0) || 1}`,
          previewUrl: normalizeString(sectionRecord?.content?.previewUrl),
          slideCount: sectionRecord?.content?.slideCount != null ? Number(sectionRecord.content.slideCount) || null : null,
          questionMetadata: Array.isArray(sectionRecord?.content?.scormMetadata?.questions)
            ? sectionRecord.content.scormMetadata.questions
            : Array.isArray(sectionRecord?.content?.scormQuestions)
              ? sectionRecord.content.scormQuestions
              : [],
        }))
      : [];

    return {
      moduleId,
      moduleOrder: Number(moduleRecord?.order || 0),
      moduleTitle: normalizeString(moduleRecord?.title) || `Module ${Number(moduleRecord?.order || 0) || 1}`,
      sections,
    } satisfies CourseStructureModule;
  });
}

export function buildCourseStructureLookup(course: any) {
  const moduleLookup = new Map<string, { moduleTitle: string; sectionLookup: Map<string, string> }>();
  const modules = buildCourseStructure(course);

  modules.forEach((moduleRecord: CourseStructureModule) => {
    moduleLookup.set(moduleRecord.moduleId, {
      moduleTitle: moduleRecord.moduleTitle,
      sectionLookup: new Map(
        moduleRecord.sections.map((sectionRecord: CourseStructureSection) => [sectionRecord.sectionId, sectionRecord.sectionTitle])
      ),
    });
  });

  return moduleLookup;
}

export function findCourseSectionStructure(course: any, moduleId?: string | null, sectionId?: string | null) {
  const normalizedModuleId = normalizeString(moduleId);
  const normalizedSectionId = normalizeString(sectionId);

  if (!normalizedSectionId) {
    return null;
  }

  const modules = buildCourseStructure(course);
  for (const moduleRecord of modules) {
    const sectionRecord = moduleRecord.sections.find((entry: { sectionId: string; }) => entry.sectionId === normalizedSectionId);
    if (!sectionRecord) {
      continue;
    }

    if (normalizedModuleId && moduleRecord.moduleId !== normalizedModuleId) {
      throw generateError("moduleId does not match the requested section", 400);
    }

    return {
      moduleId: moduleRecord.moduleId,
      moduleTitle: moduleRecord.moduleTitle,
      sectionId: sectionRecord.sectionId,
      sectionTitle: sectionRecord.sectionTitle,
      previewUrl: sectionRecord.previewUrl,
      slideCount: sectionRecord.slideCount,
      questionMetadata: sectionRecord.questionMetadata,
    };
  }

  throw generateError("Invalid SCORM section reference", 400);
}

function averageNumbers(values: number[]) {
  if (!values.length) {
    return 0;
  }

  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

function averageNullableNumbers(values: Array<number | null | undefined>) {
  const finiteValues = values.filter((value): value is number => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  return averageNumbers(finiteValues);
}

function deriveAggregateLessonStatus(statuses: ScormLessonStatus[]) {
  const normalizedStatuses = statuses.filter(Boolean);
  if (!normalizedStatuses.length) {
    return "not_attempted" as ScormLessonStatus;
  }

  if (normalizedStatuses.every((status) => COMPLETED_STATUSES.has(status))) {
    return normalizedStatuses.some((status) => status === "passed") ? "passed" : "completed";
  }

  if (
    normalizedStatuses.every((status) => COMPLETED_STATUSES.has(status) || status === "failed") &&
    normalizedStatuses.some((status) => status === "failed")
  ) {
    return "failed";
  }

  if (normalizedStatuses.some((status) => status !== "not_attempted")) {
    return "incomplete";
  }

  return "not_attempted";
}

function sumTimeValues(values: Array<string | null | undefined>) {
  return values.reduce((total, value) => total + (parseScorm12Time(value || "") || 0), 0);
}

export function buildCourseHierarchyProgress(options: {
  course: any;
  userId: string;
  courseId: string;
  sectionProgressDocs?: any[];
  courseProgressDoc?: any | null;
  allowRegression?: boolean;
}) {
  const modules = buildCourseStructure(options.course);
  const sectionProgressMap = new Map(
    (options.sectionProgressDocs || []).map((progressDoc: any) => [normalizeString(progressDoc.sectionId), progressDoc])
  );

  const moduleSummaries = modules.map((moduleRecord: { sections: any[]; moduleId: any; moduleTitle: any; moduleOrder: any; }) => {
    const sections = moduleRecord.sections.map((sectionRecord: { sectionId: string; sectionTitle: any; previewUrl: any; }) => {
      const progressDoc = sectionProgressMap.get(sectionRecord.sectionId);
      const lessonStatus = normalizeLessonStatus(progressDoc?.lessonStatus);
      const sectionProgressValue = Math.max(0, Math.min(100, Number(progressDoc?.progress || 0)));
      const isCompleted = Boolean(
        progressDoc?.isCompleted ||
        COMPLETED_STATUSES.has(lessonStatus) ||
        sectionProgressValue >= 100
      );

      return {
        moduleId: moduleRecord.moduleId,
        moduleTitle: moduleRecord.moduleTitle,
        sectionId: sectionRecord.sectionId,
        sectionTitle: sectionRecord.sectionTitle,
        previewUrl: sectionRecord.previewUrl,
        lessonStatus,
        isCompleted,
        completedAt: progressDoc?.completedAt || null,
        progress: isCompleted ? 100 : sectionProgressValue,
        score: progressDoc?.score ?? null,
        lessonLocation: progressDoc?.lessonLocation || "",
        suspendData: progressDoc?.suspendData || "",
        sessionTime: progressDoc?.sessionTime || DEFAULT_SCORM_TIME,
        totalTime: progressDoc?.totalTime || DEFAULT_SCORM_TIME,
        currentTime: Number(progressDoc?.currentTime || 0),
        duration: Number(progressDoc?.duration || 0),
        contentType: progressDoc?.contentType || "other",
        attempts: Number(progressDoc?.attempts || 0),
        lastAccessed: progressDoc?.lastAccessed || null,
        createdAt: progressDoc?.createdAt || null,
        updatedAt: progressDoc?.updatedAt || null,
      };
    });

    const moduleProgress = sections.length
      ? Math.round(averageNumbers(sections.map((section: { progress: number; }) => Number(section.progress || 0))))
      : 0;
    const moduleScore = averageNullableNumbers(sections.map((section: { score: any; }) => section.score));
    const moduleAttempts = sections.reduce((highest: number, section: { attempts: any; }) => Math.max(highest, Number(section.attempts || 0)), 0);
    const moduleTotalTime = formatScorm12Time(sumTimeValues(sections.map((section: { totalTime: any; }) => section.totalTime)));
    const moduleLessonStatus = deriveAggregateLessonStatus(
      sections.map((section: { lessonStatus: unknown; }) => normalizeLessonStatus(section.lessonStatus))
    );
    const lastAccessedValue = sections
      .map((section: { lastAccessed: string | number | Date; }) => section.lastAccessed ? new Date(section.lastAccessed).getTime() : 0)
      .reduce((latest: number, value: number) => Math.max(latest, value), 0);

    return {
      moduleId: moduleRecord.moduleId,
      moduleTitle: moduleRecord.moduleTitle,
      order: moduleRecord.moduleOrder,
      progress: moduleProgress,
      score: moduleScore,
      attempts: moduleAttempts,
      totalTime: moduleTotalTime,
      lessonStatus: moduleLessonStatus,
      lastAccessed: lastAccessedValue ? new Date(lastAccessedValue) : null,
      sections,
    };
  });

  const hasStructuredSections = moduleSummaries.some((moduleRecord: { sections: string | any[]; }) => moduleRecord.sections.length > 0);
  const allSections = moduleSummaries.flatMap((moduleRecord: { sections: any[]; }) => moduleRecord.sections);
  let courseProgress = hasStructuredSections
    ? allSections.length
      ? Math.round(averageNumbers(allSections.map((section: { progress: number; }) => Number(section.progress || 0))))
      : 0
    : Number(options.courseProgressDoc?.progress || 0);
  const courseScore = hasStructuredSections
    ? averageNullableNumbers(moduleSummaries.map((moduleRecord: { score: any; }) => moduleRecord.score))
    : options.courseProgressDoc?.score ?? null;
  const courseAttempts = hasStructuredSections
    ? moduleSummaries.reduce((highest: number, moduleRecord: { attempts: any; }) => Math.max(highest, Number(moduleRecord.attempts || 0)), 0)
    : Number(options.courseProgressDoc?.attempts || 0);
  const courseTotalTime = hasStructuredSections
    ? formatScorm12Time(sumTimeValues(moduleSummaries.map((moduleRecord: { totalTime: any; }) => moduleRecord.totalTime)))
    : options.courseProgressDoc?.totalTime || DEFAULT_SCORM_TIME;
  let courseLessonStatus = hasStructuredSections
    ? deriveAggregateLessonStatus(moduleSummaries.map((moduleRecord: { lessonStatus: unknown; }) => normalizeLessonStatus(moduleRecord.lessonStatus)))
    : options.courseProgressDoc?.lessonStatus || "not_attempted";
  if (
    !options.allowRegression &&
    COMPLETED_STATUSES.has(normalizeLessonStatus(options.courseProgressDoc?.lessonStatus))
  ) {
    courseLessonStatus = normalizeLessonStatus(options.courseProgressDoc?.lessonStatus);
    courseProgress = 100;
  }
  const courseCompletionStatus = COMPLETED_STATUSES.has(courseLessonStatus) || courseProgress >= 100
    ? "completed"
    : courseLessonStatus === "not_attempted"
      ? "not attempted"
      : "incomplete";
  const courseSuccessStatus = courseLessonStatus === "passed"
    ? "passed"
    : courseLessonStatus === "failed"
      ? "failed"
      : normalizeSuccessStatus(options.courseProgressDoc?.successStatus) || "unknown";
  const latestSection = (options.sectionProgressDocs || [])
    .slice()
    .sort((left: any, right: any) => {
      const leftTime = left?.lastAccessed ? new Date(left.lastAccessed).getTime() : 0;
      const rightTime = right?.lastAccessed ? new Date(right.lastAccessed).getTime() : 0;
      return rightTime - leftTime;
    })[0];

  const fallbackProgressDoc = options.courseProgressDoc || latestSection || null;

  return {
    course: {
      userId: options.userId,
      courseId: options.courseId,
      lessonStatus: courseLessonStatus,
      completionStatus: courseCompletionStatus,
      successStatus: courseSuccessStatus,
      progressMeasure: courseProgress,
      progress: courseProgress,
      score: courseScore,
      lessonLocation: fallbackProgressDoc?.lessonLocation || "",
      suspendData: fallbackProgressDoc?.suspendData || "",
      sessionTime: fallbackProgressDoc?.sessionTime || DEFAULT_SCORM_TIME,
      totalTime: courseTotalTime,
      attempts: hasStructuredSections ? Math.max(courseAttempts, latestSection ? 1 : 0) : courseAttempts,
      lastAccessed: latestSection?.lastAccessed || options.courseProgressDoc?.lastAccessed || null,
      createdAt: options.courseProgressDoc?.createdAt || latestSection?.createdAt || null,
      updatedAt: options.courseProgressDoc?.updatedAt || latestSection?.updatedAt || null,
    },
    modules: moduleSummaries,
  };
}

export function serializeCourseHierarchyModules(hierarchyModules: any[] = []) {
  return hierarchyModules.map((moduleRecord: any) => {
    const sections = Array.isArray(moduleRecord?.sections)
      ? moduleRecord.sections.map((sectionRecord: any) => ({
          sectionId: sectionRecord.sectionId,
          title: sectionRecord.sectionTitle,
          progress: Number(sectionRecord.progress || 0),
          score: sectionRecord.score ?? null,
          attempts: Number(sectionRecord.attempts || 0),
          lessonStatus: sectionRecord.lessonStatus,
          totalTime: sectionRecord.totalTime,
          lastAccessed: sectionRecord.lastAccessed,
          contentType: sectionRecord.contentType || "other",
          completedAt: sectionRecord.completedAt || null,
          currentTime: Number(sectionRecord.currentTime || 0),
          duration: Number(sectionRecord.duration || 0),
        }))
      : [];

    return {
      moduleId: moduleRecord.moduleId,
      title: moduleRecord.moduleTitle,
      progress: Number(moduleRecord.progress || 0),
      score: moduleRecord.score ?? null,
      attempts: Number(moduleRecord.attempts || 0),
      lessonStatus: moduleRecord.lessonStatus,
      totalTime: moduleRecord.totalTime,
      lastAccessed: moduleRecord.lastAccessed,
      sectionsCompleted: sections.filter((section: any) => {
        const normalizedStatus = normalizeLessonStatus(section.lessonStatus);
        return Boolean(section.completedAt) || COMPLETED_STATUSES.has(normalizedStatus) || Number(section.progress || 0) >= 100;
      }).length,
      sectionCount: sections.length,
      sections,
    };
  });
}

export async function syncAggregateCourseProgress(options: {
  userId: string;
  courseId: string;
  allowRegression?: boolean;
}) {
  const course = await Course.findById(options.courseId).lean();
  if (!course) {
    throw generateError("Course not found", 404);
  }

  const [sectionProgressDocs, courseProgressDoc] = await Promise.all([
    UserSectionProgress.find({
      userId: new mongoose.Types.ObjectId(options.userId),
      courseId: new mongoose.Types.ObjectId(options.courseId),
    }).lean(),
    UserCourseProgress.findOne({
      userId: new mongoose.Types.ObjectId(options.userId),
      courseId: new mongoose.Types.ObjectId(options.courseId),
    }).lean(),
  ]);

  const hierarchy = buildCourseHierarchyProgress({
    course,
    userId: options.userId,
    courseId: options.courseId,
    sectionProgressDocs,
    courseProgressDoc,
    allowRegression: options.allowRegression,
  });

  if (!hierarchy.modules.some((moduleRecord: { sections: string | any[]; }) => moduleRecord.sections.length > 0)) {
    return hierarchy;
  }

  const courseSummary = hierarchy.course;
  const progressDoc = await UserCourseProgress.findOneAndUpdate(
    {
      userId: new mongoose.Types.ObjectId(options.userId),
      courseId: new mongoose.Types.ObjectId(options.courseId),
    },
    {
      $set: {
        lessonStatus: courseSummary.lessonStatus,
        completionStatus: courseSummary.completionStatus,
        successStatus: courseSummary.successStatus,
        progressMeasure: courseSummary.progressMeasure,
        progress: courseSummary.progress,
        score: courseSummary.score,
        lessonLocation: courseSummary.lessonLocation,
        suspendData: courseSummary.suspendData,
        sessionTime: courseSummary.sessionTime,
        totalTime: courseSummary.totalTime,
        attempts: Math.max(Number(courseSummary.attempts || 0), 1),
        lastAccessed: courseSummary.lastAccessed || new Date(),
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
    }
  );

  await syncEnrollmentProgress({
    userId: options.userId,
    courseId: options.courseId,
    lessonStatus: normalizeLessonStatus(progressDoc.lessonStatus),
    progress: Number(progressDoc.progress || 0),
    allowRegression: options.allowRegression,
  });

  return {
    ...hierarchy,
    course: serializeCourseProgress(progressDoc),
  };
}
