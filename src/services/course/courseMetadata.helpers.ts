export type CourseVisibilityType = "private" | "public";
export type CourseType = "standard" | "scorm";
export type CourseAssessmentOutcome = "passed" | "failed" | "pending" | "not_configured";

function normalizeString(value: unknown) {
  return String(value || "").trim();
}

function normalizeNullableNumber(value: unknown) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  return value
    .map((entry) => normalizeString(entry))
    .filter((entry) => {
      if (!entry) {
        return false;
      }

      const normalizedKey = entry.toLowerCase();
      if (seen.has(normalizedKey)) {
        return false;
      }

      seen.add(normalizedKey);
      return true;
    });
}

export function normalizeCourseVisibilityType(
  value: unknown,
  fallback: CourseVisibilityType = "private"
): CourseVisibilityType {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return normalizedValue === "public" ? "public" : fallback;
}

export function normalizeCourseAssessment(assessmentLike: any) {
  const totalMarksValue = normalizeNullableNumber(assessmentLike?.totalMarks);
  const passingMarksValue = normalizeNullableNumber(assessmentLike?.passingMarks);
  const totalMarks =
    totalMarksValue !== null && totalMarksValue > 0 ? Math.round(totalMarksValue * 100) / 100 : null;
  let passingMarks =
    passingMarksValue !== null && passingMarksValue >= 0 ? Math.round(passingMarksValue * 100) / 100 : null;

  if (totalMarks === null) {
    passingMarks = null;
  } else if (passingMarks !== null && passingMarks > totalMarks) {
    passingMarks = totalMarks;
  }

  return {
    totalMarks,
    passingMarks,
  };
}

export function normalizeCourseHighlights(highlightsLike: any) {
  return {
    learningOutcomes: normalizeStringList(
      highlightsLike?.learningOutcomes ||
        highlightsLike?.whatYouWillLearn ||
        highlightsLike?.outcomes
    ),
  };
}

export function normalizeCourseInstructorForStorage(instructorLike: any) {
  return {
    name: normalizeString(instructorLike?.name),
    designation: normalizeString(instructorLike?.designation),
  };
}

export function buildCourseInstructorSummary(course: any) {
  const storedInstructor = course?.instructor || {};
  const creator =
    course?.createdBy && typeof course.createdBy === "object" ? course.createdBy : null;
  const creatorCompany =
    creator?.company && typeof creator.company === "object" ? creator.company : null;
  const owningCompany =
    course?.company && typeof course.company === "object" ? course.company : null;

  return {
    name: normalizeString(storedInstructor?.name || creator?.name),
    designation: normalizeString(storedInstructor?.designation || creator?.designation),
    companyName: normalizeString(
      owningCompany?.company_name || creatorCompany?.company_name
    ),
    avatarUrl: normalizeString(creator?.pic?.url),
  };
}

export function serializeCoursePresentation(course: any) {
  if (!course) {
    return course;
  }

  return {
    ...course,
    highlights: normalizeCourseHighlights(course?.highlights),
    instructor: buildCourseInstructorSummary(course),
  };
}

export function deriveCourseType(course: any): CourseType {
  if (String(course?.scormFilePath || "").trim()) {
    return "scorm";
  }

  const modules = Array.isArray(course?.curriculum?.modules) ? course.curriculum.modules : [];
  const hasScormAsset = modules.some((moduleRecord: any) =>
    (moduleRecord?.sections || []).some((sectionRecord: any) => {
      const kind = String(sectionRecord?.content?.kind || "").trim().toLowerCase();
      return kind === "scorm" || kind === "zip";
    })
  );

  return hasScormAsset ? "scorm" : "standard";
}

function normalizeProgressValue(value: unknown) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function normalizeScoreToMarks(score: number | null, totalMarks: number | null) {
  if (score === null) {
    return null;
  }

  if (totalMarks !== null && totalMarks > 0) {
    if (score <= totalMarks) {
      return Math.round(score * 100) / 100;
    }

    if (score <= 100) {
      return Math.round(((score / 100) * totalMarks) * 100) / 100;
    }
  }

  return Math.round(score * 100) / 100;
}

export function buildCourseAssessmentSummary(options: {
  assessment?: any;
  score?: number | null;
  progress?: number | null;
  lessonStatus?: string | null;
}) {
  const assessment = normalizeCourseAssessment(options.assessment);
  const rawScore = normalizeNullableNumber(options.score);
  const progress = normalizeProgressValue(options.progress);
  const normalizedLessonStatus = String(options.lessonStatus || "").trim().toLowerCase();
  const earnedMarks = normalizeScoreToMarks(rawScore, assessment.totalMarks);
  const scorePercentage =
    assessment.totalMarks && assessment.totalMarks > 0 && earnedMarks !== null
      ? Math.round(((earnedMarks / assessment.totalMarks) * 100) * 100) / 100
      : rawScore !== null && rawScore >= 0 && rawScore <= 100
        ? Math.round(rawScore * 100) / 100
        : null;

  if (assessment.totalMarks === null || assessment.passingMarks === null) {
    return {
      ...assessment,
      earnedMarks,
      scorePercentage,
      outcome: "not_configured" as CourseAssessmentOutcome,
    };
  }

  if (normalizedLessonStatus === "passed") {
    return {
      ...assessment,
      earnedMarks,
      scorePercentage,
      outcome: "passed" as CourseAssessmentOutcome,
    };
  }

  if (normalizedLessonStatus === "failed") {
    return {
      ...assessment,
      earnedMarks,
      scorePercentage,
      outcome: "failed" as CourseAssessmentOutcome,
    };
  }

  const isFinalState =
    normalizedLessonStatus === "completed" ||
    normalizedLessonStatus === "passed" ||
    normalizedLessonStatus === "failed" ||
    progress >= 100;

  if (!isFinalState || earnedMarks === null) {
    return {
      ...assessment,
      earnedMarks,
      scorePercentage,
      outcome: "pending" as CourseAssessmentOutcome,
    };
  }

  return {
    ...assessment,
    earnedMarks,
    scorePercentage,
    outcome: earnedMarks >= assessment.passingMarks ? ("passed" as CourseAssessmentOutcome) : ("failed" as CourseAssessmentOutcome),
  };
}
