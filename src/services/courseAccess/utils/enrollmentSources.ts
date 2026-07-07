import CourseEnrollment from "../../../schemas/course/CourseEnrollment";
import { normalizeCourseAssessment } from "../../course/courseMetadata.helpers";
import { getValidityStatus, isWithinValidityWindow, toObjectId } from "./accessControl";

export type EnrollmentAssessmentCriteria = {
  totalMarks?: number | null;
  passingMarks?: number | null;
};

export type EnrollmentSourceInput = {
  type: "direct" | "batch" | "self";
  batchId?: string | null;
  batchName?: string | null;
  assignedBy: string;
  assessmentCriteria?: EnrollmentAssessmentCriteria | null;
  validFrom?: Date | string | null;
  validTill?: Date | string | null;
  dueDate?: Date | string | null;
  assignedAt?: Date | string | null;
};

function stringifyId(value: any) {
  return value ? String(value) : "";
}

function toNullableDate(value?: Date | string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sourceKey(source: any) {
  if (String(source?.type) === "batch") {
    return `batch:${stringifyId(source?.batchId)}`;
  }

  return String(source?.type) === "self" ? "self" : "direct";
}

function normalizeAssessmentCriteria(criteriaLike: EnrollmentAssessmentCriteria | null | undefined) {
  const normalized = normalizeCourseAssessment(criteriaLike || {});
  if (normalized.totalMarks === null && normalized.passingMarks === null) {
    return null;
  }

  return normalized;
}

export function normalizeEnrollmentSources(enrollment: any) {
  if (Array.isArray(enrollment?.sources) && enrollment.sources.length > 0) {
    return enrollment.sources;
  }

  if (!enrollment?.assignedBy) {
    return [];
  }

  return [
    {
      type: "direct",
      batchId: null,
      batchName: null,
      assignedBy: enrollment.assignedBy,
      assessmentCriteria: normalizeAssessmentCriteria(enrollment.assessmentCriteria || enrollment.courseId?.assessment),
      validFrom: enrollment.validFrom || enrollment.createdAt || new Date(),
      validTill: enrollment.validTill || null,
      dueDate: enrollment.dueDate || null,
      assignedAt: enrollment.createdAt || new Date(),
    },
  ];
}

export function enrichEnrollmentSources(enrollment: any) {
  return normalizeEnrollmentSources(enrollment).map((source: any) => {
    const isExpired = !isWithinValidityWindow(source.validFrom, source.validTill);
    return {
      ...source,
      assessmentCriteria: normalizeAssessmentCriteria(source.assessmentCriteria),
      isExpired,
      status: isExpired ? "expired" : getValidityStatus(source.validFrom, source.validTill),
    };
  });
}

export function getActiveEnrollmentSources(enrollment: any) {
  return enrichEnrollmentSources(enrollment).filter((source: any) => !source.isExpired);
}

function deriveAggregateFields(sources: any[]) {
  const validFromValues = sources
    .map((source) => toNullableDate(source.validFrom))
    .filter(Boolean) as Date[];
  const validTillValues = sources
    .map((source) => toNullableDate(source.validTill))
    .filter(Boolean) as Date[];
  const dueDateValues = sources
    .map((source) => toNullableDate(source.dueDate))
    .filter(Boolean) as Date[];

  const validFrom =
    validFromValues.length > 0
      ? new Date(Math.min(...validFromValues.map((value) => value.getTime())))
      : new Date();
  const validTill =
    sources.some((source) => !source.validTill)
      ? null
      : validTillValues.length > 0
        ? new Date(Math.max(...validTillValues.map((value) => value.getTime())))
        : null;
  const dueDate =
    dueDateValues.length > 0
      ? new Date(Math.max(...dueDateValues.map((value) => value.getTime())))
      : null;

  return { validFrom, validTill, dueDate };
}

function buildSourceDocument(source: EnrollmentSourceInput) {
  return {
    type: source.type,
    batchId: source.batchId ? toObjectId(source.batchId) : null,
    batchName: source.batchName || null,
    assignedBy: toObjectId(source.assignedBy),
    assessmentCriteria: normalizeAssessmentCriteria(source.assessmentCriteria),
    validFrom: toNullableDate(source.validFrom) || new Date(),
    validTill: toNullableDate(source.validTill),
    dueDate: toNullableDate(source.dueDate),
    assignedAt: toNullableDate(source.assignedAt) || new Date(),
  };
}

function compareSourceForUpdate(source: any) {
  return JSON.stringify({
    key: sourceKey(source),
    assignedBy: stringifyId(source.assignedBy),
    assessmentCriteria: normalizeAssessmentCriteria(source.assessmentCriteria),
    validFrom: toNullableDate(source.validFrom)?.toISOString() || null,
    validTill: toNullableDate(source.validTill)?.toISOString() || null,
    dueDate: toNullableDate(source.dueDate)?.toISOString() || null,
    assignedAt: toNullableDate(source.assignedAt)?.toISOString() || null,
  });
}

function pickMergedValidTill(sources: any[]) {
  const activeSources = sources.filter((source) => !source.isExpired);
  const sourcePool = activeSources.length > 0 ? activeSources : sources;

  if (!sourcePool.length) {
    return null;
  }

  if (activeSources.some((source) => !source.validTill)) {
    return null;
  }

  const validTillValues = sourcePool
    .map((source) => toNullableDate(source.validTill))
    .filter(Boolean) as Date[];

  if (!validTillValues.length) {
    return null;
  }

  return new Date(Math.max(...validTillValues.map((value) => value.getTime())));
}

export function resolveEffectiveEnrollmentAssessment(enrollment: any, fallbackAssessment?: any) {
  const enrichedSources = enrichEnrollmentSources(enrollment);
  const sourcePool = enrichedSources.some((source: any) => !source.isExpired)
    ? enrichedSources.filter((source: any) => !source.isExpired)
    : enrichedSources;

  const prioritizedSources = [...sourcePool].sort((left: any, right: any) => {
    const sourcePriority = (source: any) =>
      String(source?.type) === "direct" ? 2 : String(source?.type) === "self" ? 1 : 0;
    const leftPriority = sourcePriority(left);
    const rightPriority = sourcePriority(right);

    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }

    const leftAssignedAt = toNullableDate(left.assignedAt)?.getTime() || 0;
    const rightAssignedAt = toNullableDate(right.assignedAt)?.getTime() || 0;
    return rightAssignedAt - leftAssignedAt;
  });

  const chosenCriteria = prioritizedSources.find((source: any) => normalizeAssessmentCriteria(source.assessmentCriteria))
    ?.assessmentCriteria;
  const fallbackCriteria = normalizeAssessmentCriteria(
    enrollment?.assessmentCriteria || fallbackAssessment || enrollment?.courseId?.assessment
  );

  return normalizeAssessmentCriteria({
    totalMarks: chosenCriteria?.totalMarks ?? fallbackCriteria?.totalMarks ?? null,
    passingMarks: chosenCriteria?.passingMarks ?? fallbackCriteria?.passingMarks ?? null,
  });
}

export function buildMergedEnrollmentSummary(enrollment: any) {
  const enrichedSources = enrichEnrollmentSources(enrollment);
  const activeSources = enrichedSources.filter((source: any) => !source.isExpired);
  const mergedValidTill = pickMergedValidTill(enrichedSources);
  const isExpired = activeSources.length === 0;
  const status = isExpired ? "expired" : getValidityStatus(enrollment.validFrom, mergedValidTill);
  const progress =
    enrollment?.progressPercent !== undefined && enrollment?.progressPercent !== null
      ? Number(enrollment.progressPercent)
      : enrollment?.status === "completed"
        ? 100
        : enrollment?.status === "in_progress"
          ? 50
          : 0;

  return {
    courseId: stringifyId(enrollment.courseId?._id || enrollment.courseId),
    title: enrollment.courseId?.title || "",
    progress,
    status: enrollment?.status || "not_started",
    sources: enrichedSources.map((source: any) => ({
      type: source.type,
      batchId: source.batchId || null,
      batchName: source.batchName || null,
      label:
        source.type === "batch"
          ? `From Batch: ${source.batchName || "Batch"}`
          : source.type === "self"
            ? "Self Enrolled"
            : "Direct Assignment",
      assessmentCriteria: normalizeAssessmentCriteria(source.assessmentCriteria),
      validFrom: source.validFrom || null,
      validTill: source.validTill || null,
      dueDate: source.dueDate || null,
      assignedAt: source.assignedAt || enrollment.createdAt || null,
      isExpired: source.isExpired,
      status: source.status,
    })),
    assessmentCriteria: resolveEffectiveEnrollmentAssessment(enrollment),
    validTill: mergedValidTill,
    isExpired,
    visibilityStatus: status,
  };
}

export async function upsertEnrollmentSources(options: {
  courseIds: string[];
  users: any[];
  source: EnrollmentSourceInput;
}) {
  const uniqueCourseIds = [...new Set(options.courseIds.map((courseId) => String(courseId).trim()).filter(Boolean))];
  const uniqueUsers = Array.from(
    new Map(options.users.map((user) => [String(user._id), user])).values()
  );

  if (!uniqueCourseIds.length || !uniqueUsers.length) {
    return {
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      createdEntries: [] as string[],
      updatedEntries: [] as string[],
      skippedEntries: [] as string[],
    };
  }

  const existingEnrollments = await CourseEnrollment.find({
    courseId: { $in: uniqueCourseIds.map((courseId) => toObjectId(courseId)) },
    userId: { $in: uniqueUsers.map((user) => user._id) },
  }).lean();

  const existingMap = new Map(
    existingEnrollments.map((enrollment: any) => [
      `${stringifyId(enrollment.courseId)}:${stringifyId(enrollment.userId)}`,
      enrollment,
    ])
  );

  const operations: any[] = [];
  const createdEntries: string[] = [];
  const updatedEntries: string[] = [];
  const skippedEntries: string[] = [];

  for (const courseId of uniqueCourseIds) {
    for (const user of uniqueUsers) {
      const key = `${courseId}:${stringifyId(user._id)}`;
      const builtSource = buildSourceDocument(options.source);
      const existing = existingMap.get(key);

      if (!existing) {
        operations.push({
          insertOne: {
            document: {
              courseId: toObjectId(courseId),
              userId: user._id,
              assignedBy: builtSource.assignedBy,
              status: "not_started",
              assessmentCriteria: builtSource.assessmentCriteria,
              validFrom: builtSource.validFrom,
              validTill: builtSource.validTill,
              dueDate: builtSource.dueDate,
              sources: [builtSource],
            },
          },
        });
        createdEntries.push(key);
        continue;
      }

      const existingSources = normalizeEnrollmentSources(existing);
      const duplicateIndex = existingSources.findIndex(
        (source: any) => sourceKey(source) === sourceKey(builtSource)
      );
      const nextSources = [...existingSources];

      if (duplicateIndex >= 0) {
        const nextSource = {
          ...nextSources[duplicateIndex],
          ...builtSource,
        };

        if (compareSourceForUpdate(nextSources[duplicateIndex]) === compareSourceForUpdate(nextSource)) {
          skippedEntries.push(key);
          continue;
        }

        nextSources[duplicateIndex] = nextSource;
      } else {
        nextSources.push(builtSource);
      }

      const aggregate = deriveAggregateFields(nextSources);
      const assessmentCriteria = resolveEffectiveEnrollmentAssessment({
        ...existing,
        sources: nextSources,
      });

      operations.push({
        updateOne: {
          filter: { _id: existing._id },
          update: {
            $set: {
              assignedBy: builtSource.assignedBy,
              assessmentCriteria,
              validFrom: aggregate.validFrom,
              validTill: aggregate.validTill,
              dueDate: aggregate.dueDate,
              sources: nextSources,
            },
          },
        },
      });
      updatedEntries.push(key);
    }
  }

  if (operations.length) {
    await CourseEnrollment.bulkWrite(operations);
  }

  return {
    createdCount: createdEntries.length,
    updatedCount: updatedEntries.length,
    skippedCount: skippedEntries.length,
    createdEntries,
    updatedEntries,
    skippedEntries,
  };
}

export async function removeBatchEnrollmentSources(options: {
  batchId: string;
  userIds?: string[];
  courseIds?: string[];
}) {
  const query: any = {
    "sources.type": "batch",
    "sources.batchId": toObjectId(options.batchId),
  };

  if (options.userIds?.length) {
    query.userId = { $in: options.userIds.map((userId) => toObjectId(userId)) };
  }

  if (options.courseIds?.length) {
    query.courseId = { $in: options.courseIds.map((courseId) => toObjectId(courseId)) };
  }

  const enrollments = await CourseEnrollment.find(query).lean();

  for (const enrollment of enrollments) {
    const remainingSources = normalizeEnrollmentSources(enrollment).filter(
      (source: any) =>
        !(String(source.type) === "batch" && stringifyId(source.batchId) === String(options.batchId))
    );

    if (!remainingSources.length) {
      await CourseEnrollment.deleteOne({ _id: enrollment._id });
      continue;
    }

    const aggregate = deriveAggregateFields(remainingSources);
    const assessmentCriteria = resolveEffectiveEnrollmentAssessment({
      ...enrollment,
      sources: remainingSources,
      assessmentCriteria: enrollment.assessmentCriteria,
    });
    await CourseEnrollment.updateOne(
      { _id: enrollment._id },
      {
        $set: {
          sources: remainingSources,
          assessmentCriteria,
          validFrom: aggregate.validFrom,
          validTill: aggregate.validTill,
          dueDate: aggregate.dueDate,
          assignedBy: remainingSources[remainingSources.length - 1]?.assignedBy || enrollment.assignedBy,
        },
      }
    );
  }

  return { affectedCount: enrollments.length };
}
