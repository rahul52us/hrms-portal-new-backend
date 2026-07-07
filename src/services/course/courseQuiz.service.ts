import crypto from "crypto";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { NextFunction, Response } from "express";
import { generateError } from "../../config/Error/functions";
import Course from "../../schemas/course/Course";
import CourseQuizAttempt from "../../schemas/course/CourseQuizAttempt";
import UserCourseProgress from "../../schemas/course/UserCourseProgress";
import {
  assertEnrollmentAccess,
  normalizeObjectId,
  normalizeString,
  stringifyId,
  syncEnrollmentProgress,
} from "../scorm/scormTracking.helpers";

const OPTION_LABELS = ["Option-1", "Option-2", "Option-3", "Option-4"];
const DEFAULT_QUIZ_MARKS = 1;

type CourseQuizScope = "module" | "final";

type NormalizedCourseQuizQuestion = {
  questionId: string;
  sn: number;
  question: string;
  options: Array<{
    optionId: string;
    label: string;
    text: string;
    isCorrect: boolean;
  }>;
  correctOptionId: string;
  correctOptionLabel: string;
  marks: number;
  explanation: string;
};

type NormalizedCourseQuiz = {
  quizId: string;
  title: string;
  scope: CourseQuizScope;
  moduleId: string;
  source: "manual" | "excel" | "mixed";
  questionCount: number;
  totalMarks: number;
  questions: NormalizedCourseQuizQuestion[];
  updatedAt: Date;
};

type CourseQuizDefinition = NormalizedCourseQuiz & {
  moduleTitle: string;
  order: number;
};

function createStableId(parts: unknown[]) {
  const raw = parts.map((part) => normalizeString(part)).filter(Boolean).join(":");
  return crypto.createHash("sha1").update(raw || `${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
}

function normalizeNumber(value: unknown, fallback: number | null = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeMarks(value: unknown) {
  const numericValue = normalizeNumber(value, DEFAULT_QUIZ_MARKS);
  return Math.max(0, Math.round(Number(numericValue || DEFAULT_QUIZ_MARKS) * 100) / 100);
}

function normalizeHeader(value: unknown) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeCorrectOptionLabel(value: unknown, optionTexts: string[]) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return "";
  }

  const compactValue = normalizedValue.toLowerCase().replace(/\s+/g, "").replace(/_/g, "-");
  const optionMatch = compactValue.match(/^option-?([1-4])$/i) || compactValue.match(/^([1-4])$/);
  if (optionMatch?.[1]) {
    return `Option-${optionMatch[1]}`;
  }

  const optionIndex = optionTexts.findIndex(
    (optionText) => optionText && optionText.trim().toLowerCase() === normalizedValue.trim().toLowerCase()
  );
  return optionIndex >= 0 ? `Option-${optionIndex + 1}` : "";
}

function getCellText(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    const richText = (value as any).richText;
    if (Array.isArray(richText)) {
      return richText.map((entry) => normalizeString(entry.text)).join("");
    }

    if ((value as any).text !== undefined) {
      return normalizeString((value as any).text);
    }

    if ((value as any).result !== undefined) {
      return normalizeString((value as any).result);
    }
  }

  return normalizeString(value);
}

function buildQuestionFromInput(input: any, index: number, context: { quizId: string }) {
  const optionTexts = OPTION_LABELS.map((label, optionIndex) => {
    const compactKey = `option${optionIndex + 1}`;
    return normalizeString(
      input?.[label] ??
      input?.[label.toLowerCase()] ??
      input?.[compactKey] ??
      input?.[`Option ${optionIndex + 1}`] ??
      input?.options?.[optionIndex]?.text ??
      input?.options?.[optionIndex] ??
      ""
    );
  });
  const correctOptionLabel = normalizeCorrectOptionLabel(
    input?.correctOption ?? input?.correct ?? input?.answer ?? input?.correctAnswer,
    optionTexts
  );
  const correctOptionIndex = OPTION_LABELS.indexOf(correctOptionLabel);
  const questionText = normalizeString(input?.question ?? input?.Question ?? input?.prompt ?? "");

  if (!questionText || optionTexts.some((optionText) => !optionText) || correctOptionIndex < 0) {
    return null;
  }

  const snValue = normalizeNumber(input?.sn ?? input?.SN ?? input?.serialNumber, index + 1);
  const questionId =
    normalizeString(input?.questionId || input?.id) ||
    `q-${index + 1}-${createStableId([context.quizId, questionText, index])}`;

  return {
    questionId,
    sn: Number(snValue || index + 1),
    question: questionText,
    options: optionTexts.map((text, optionIndex) => ({
      optionId: `option-${optionIndex + 1}`,
      label: OPTION_LABELS[optionIndex],
      text,
      isCorrect: optionIndex === correctOptionIndex,
    })),
    correctOptionId: `option-${correctOptionIndex + 1}`,
    correctOptionLabel,
    marks: normalizeMarks(input?.marks ?? input?.Marks ?? input?.score ?? input?.Score),
    explanation: normalizeString(input?.explanation ?? input?.Explanation ?? ""),
  } satisfies NormalizedCourseQuizQuestion;
}

export function normalizeCourseQuizPayload(
  quizLike: any,
  options: {
    scope: CourseQuizScope;
    moduleId?: string;
    moduleTitle?: string;
    fallbackTitle?: string;
    fallbackQuizId?: string;
  }
): NormalizedCourseQuiz | null {
  const questionsLike = Array.isArray(quizLike?.questions) ? quizLike.questions : [];
  const quizId =
    normalizeString(quizLike?.quizId || quizLike?.id) ||
    options.fallbackQuizId ||
    `${options.scope}-${createStableId([options.moduleId, options.fallbackTitle])}`;

  const questions: NormalizedCourseQuizQuestion[] = questionsLike
    .map((questionLike: any, index: number) => buildQuestionFromInput(questionLike, index, { quizId }))
    .filter((question: NormalizedCourseQuizQuestion | null): question is NormalizedCourseQuizQuestion => Boolean(question));

  if (!questions.length) {
    return null;
  }

  const source = normalizeString(quizLike?.source).toLowerCase();
  const normalizedSource = source === "excel" || source === "mixed" ? source : "manual";
  const totalMarks = questions.reduce((total: number, question: NormalizedCourseQuizQuestion) => total + normalizeMarks(question.marks), 0);

  return {
    quizId,
    title:
      normalizeString(quizLike?.title) ||
      options.fallbackTitle ||
      (options.scope === "final" ? "Final course quiz" : `${options.moduleTitle || "Module"} quiz`),
    scope: options.scope,
    moduleId: normalizeString(options.moduleId),
    source: normalizedSource as "manual" | "excel" | "mixed",
    questionCount: questions.length,
    totalMarks: Math.round(totalMarks * 100) / 100,
    questions,
    updatedAt: new Date(),
  };
}

export function normalizeCourseQuizConfiguration(curriculumLike: any) {
  const quizStrategy = normalizeString(curriculumLike?.quizStrategy) === "final" ? "final" : "per-module";
  let totalMarks = 0;
  const modules = (Array.isArray(curriculumLike?.modules) ? curriculumLike.modules : []).map((moduleRecord: any, index: number) => {
    const moduleId = `module-${Number(moduleRecord?.order || index + 1)}`;
    const quiz = normalizeCourseQuizPayload(moduleRecord?.assessments?.quiz || moduleRecord?.quiz, {
      scope: "module",
      moduleId,
      moduleTitle: moduleRecord?.title,
      fallbackTitle: `${moduleRecord?.title || `Module ${index + 1}`} quiz`,
      fallbackQuizId: `module-${Number(moduleRecord?.order || index + 1)}-quiz`,
    });
    const quizEnabled = quizStrategy === "per-module" && Boolean(quiz);

    if (quizEnabled && quiz) {
      totalMarks += quiz.totalMarks;
    }

    return {
      ...moduleRecord,
      assessments: {
        ...(moduleRecord?.assessments || {}),
        quizEnabled,
        quiz: quizEnabled ? quiz : null,
      },
    };
  });

  const finalQuiz = normalizeCourseQuizPayload(curriculumLike?.finalQuiz, {
    scope: "final",
    fallbackTitle: "Final course quiz",
    fallbackQuizId: "final-course-quiz",
  });

  if (quizStrategy === "final" && finalQuiz) {
    totalMarks += finalQuiz.totalMarks;
  }

  return {
    quizStrategy,
    modules,
    finalQuiz: quizStrategy === "final" ? finalQuiz : null,
    totalMarks: Math.round(totalMarks * 100) / 100,
  };
}

export function extractCourseQuizDefinitions(course: any): CourseQuizDefinition[] {
  const modules = Array.isArray(course?.curriculum?.modules) ? course.curriculum.modules : [];
  const definitions: CourseQuizDefinition[] = [];

  modules.forEach((moduleRecord: any, index: number) => {
    const quiz = moduleRecord?.assessments?.quiz;
    if (!moduleRecord?.assessments?.quizEnabled || !quiz?.questions?.length) {
      return;
    }

    definitions.push({
      ...(quiz as NormalizedCourseQuiz),
      scope: "module",
      moduleId: normalizeString(quiz.moduleId) || `module-${Number(moduleRecord?.order || index + 1)}`,
      moduleTitle: normalizeString(moduleRecord?.title) || `Module ${index + 1}`,
      order: Number(moduleRecord?.order || index + 1),
    });
  });

  const finalQuiz = course?.curriculum?.finalQuiz;
  if (finalQuiz?.questions?.length) {
    definitions.push({
      ...(finalQuiz as NormalizedCourseQuiz),
      scope: "final",
      moduleId: "final",
      moduleTitle: "Final Quiz",
      order: 9999,
    });
  }

  return definitions;
}

export function getCourseQuizTotalMarks(course: any) {
  return extractCourseQuizDefinitions(course).reduce((total, quiz) => total + Number(quiz.totalMarks || 0), 0);
}

function sanitizeQuizDefinitionForLearner(quiz: any) {
  if (!quiz) {
    return null;
  }

  return {
    ...quiz,
    questions: Array.isArray(quiz.questions)
      ? quiz.questions.map((question: any) => ({
          questionId: normalizeString(question.questionId),
          sn: Number(question.sn || 0),
          question: normalizeString(question.question),
          marks: Number(question.marks || 0),
          explanation: "",
          options: Array.isArray(question.options)
            ? question.options.map((option: any) => ({
                optionId: normalizeString(option.optionId),
                label: normalizeString(option.label),
                text: normalizeString(option.text),
              }))
            : [],
        }))
      : [],
  };
}

export function sanitizeCourseCurriculumForLearner(curriculum: any) {
  if (!curriculum) {
    return curriculum;
  }

  return {
    ...curriculum,
    finalQuiz: sanitizeQuizDefinitionForLearner(curriculum.finalQuiz),
    modules: Array.isArray(curriculum.modules)
      ? curriculum.modules.map((moduleRecord: any) => ({
          ...moduleRecord,
          assessments: {
            ...(moduleRecord?.assessments || {}),
            quiz: sanitizeQuizDefinitionForLearner(moduleRecord?.assessments?.quiz),
          },
        }))
      : [],
  };
}

export async function parseCourseQuizExcel(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw generateError("The workbook does not contain any worksheets", 422);
  }

  const headerRow = worksheet.getRow(1);
  const headers = new Map<string, number>();
  headerRow.eachCell((cell, columnNumber) => {
    headers.set(normalizeHeader(getCellText(cell.value)), columnNumber);
  });

  const findColumn = (candidates: string[]) => {
    for (const candidate of candidates) {
      const columnNumber = headers.get(normalizeHeader(candidate));
      if (columnNumber) {
        return columnNumber;
      }
    }

    return 0;
  };

  const columnMap = {
    sn: findColumn(["SN", "S.No", "Serial Number", "No"]),
    question: findColumn(["Question", "Question Text", "Prompt"]),
    option1: findColumn(["Option-1", "Option 1", "Option1"]),
    option2: findColumn(["Option-2", "Option 2", "Option2"]),
    option3: findColumn(["Option-3", "Option 3", "Option3"]),
    option4: findColumn(["Option-4", "Option 4", "Option4"]),
    correctOption: findColumn(["Correct Option", "Correct", "Answer", "Correct Answer"]),
    marks: findColumn(["Marks", "Score", "Points"]),
    explanation: findColumn(["Explanation", "Feedback", "Description"]),
  };

  if (!columnMap.question || !columnMap.option1 || !columnMap.option2 || !columnMap.option3 || !columnMap.option4 || !columnMap.correctOption) {
    throw generateError("Quiz Excel must include Question, Option-1, Option-2, Option-3, Option-4, and Correct Option columns", 422);
  }

  const rows: any[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      return;
    }

    const rowLike = {
      sn: columnMap.sn ? getCellText(row.getCell(columnMap.sn).value) : rowNumber - 1,
      question: getCellText(row.getCell(columnMap.question).value),
      option1: getCellText(row.getCell(columnMap.option1).value),
      option2: getCellText(row.getCell(columnMap.option2).value),
      option3: getCellText(row.getCell(columnMap.option3).value),
      option4: getCellText(row.getCell(columnMap.option4).value),
      correctOption: getCellText(row.getCell(columnMap.correctOption).value),
      marks: columnMap.marks ? getCellText(row.getCell(columnMap.marks).value) : DEFAULT_QUIZ_MARKS,
      explanation: columnMap.explanation ? getCellText(row.getCell(columnMap.explanation).value) : "",
    };

    if (Object.values(rowLike).some((value) => normalizeString(value))) {
      rows.push(rowLike);
    }
  });

  const quiz = normalizeCourseQuizPayload(
    {
      quizId: `excel-preview-${createStableId([Date.now(), rows.length])}`,
      title: worksheet.name || "Uploaded quiz",
      source: "excel",
      questions: rows,
    },
    {
      scope: "final",
      fallbackTitle: worksheet.name || "Uploaded quiz",
    }
  );

  if (!quiz) {
    throw generateError("No valid quiz questions were found in the workbook", 422);
  }

  return quiz;
}

function createSeededRandom(seed: string) {
  let state = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffleWithSeed<T>(items: T[], seed: string) {
  const nextItems = [...items];
  const random = createSeededRandom(seed);

  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]];
  }

  return nextItems;
}

function serializeAttemptForLearner(attempt: any) {
  if (!attempt) {
    return null;
  }

  return {
    _id: stringifyId(attempt._id),
    quizId: normalizeString(attempt.quizId),
    quizTitle: normalizeString(attempt.quizTitle),
    scope: attempt.scope,
    moduleId: normalizeString(attempt.moduleId),
    moduleTitle: normalizeString(attempt.moduleTitle),
    score: Number(attempt.score || 0),
    maxScore: Number(attempt.maxScore || 0),
    percentage: Number(attempt.percentage || 0),
    correctCount: Number(attempt.correctCount || 0),
    incorrectCount: Number(attempt.incorrectCount || 0),
    questionCount: Number(attempt.questionCount || 0),
    attemptNumber: Number(attempt.attemptNumber || 1),
    submittedAt: attempt.submittedAt || attempt.updatedAt || null,
    answers: Array.isArray(attempt.answers)
      ? attempt.answers.map((answer: any) => ({
          questionId: normalizeString(answer.questionId),
          question: normalizeString(answer.question),
          selectedOptionId: normalizeString(answer.selectedOptionId),
          selectedOptionLabel: normalizeString(answer.selectedOptionLabel),
          selectedAnswerText: normalizeString(answer.selectedAnswerText),
          correctOptionId: normalizeString(answer.correctOptionId),
          correctOptionLabel: normalizeString(answer.correctOptionLabel),
          correctAnswerText: normalizeString(answer.correctAnswerText),
          isCorrect: Boolean(answer.isCorrect),
          marksAwarded: Number(answer.marksAwarded || 0),
          maxMarks: Number(answer.maxMarks || 0),
        }))
      : [],
  };
}

function serializeQuizForLearner(quiz: CourseQuizDefinition, userId: string, courseId: string, attempt: any) {
  const shuffledQuestions = shuffleWithSeed(
    quiz.questions || [],
    `${userId}:${courseId}:${quiz.quizId}`
  );

  return {
    quizId: quiz.quizId,
    title: quiz.title,
    scope: quiz.scope,
    moduleId: quiz.moduleId,
    moduleTitle: quiz.moduleTitle,
    questionCount: quiz.questionCount,
    totalMarks: quiz.totalMarks,
    attempt: serializeAttemptForLearner(attempt),
    questions: shuffledQuestions.map((question) => ({
      questionId: question.questionId,
      sn: question.sn,
      question: question.question,
      marks: question.marks,
      options: question.options.map((option) => ({
        optionId: option.optionId,
        label: option.label,
        text: option.text,
      })),
    })),
  };
}

async function syncCourseQuizScore(options: { userId: string; courseId: string }) {
  const course = await Course.findById(options.courseId).lean();
  if (!course) {
    throw generateError("Course not found", 404);
  }

  const quizDefinitions = extractCourseQuizDefinitions(course);
  const possibleMarks = quizDefinitions.reduce((total, quiz) => total + Number(quiz.totalMarks || 0), 0);
  if (possibleMarks <= 0) {
    return null;
  }

  const attempts = await CourseQuizAttempt.find({
    userId: new mongoose.Types.ObjectId(options.userId),
    courseId: new mongoose.Types.ObjectId(options.courseId),
    quizId: { $in: quizDefinitions.map((quiz) => quiz.quizId) },
  }).lean();
  const attemptMap = new Map(attempts.map((attempt: any) => [normalizeString(attempt.quizId), attempt]));
  const awardedMarks = quizDefinitions.reduce((total, quiz) => {
    const attempt = attemptMap.get(quiz.quizId);
    return total + Number(attempt?.score || 0);
  }, 0);
  const percentage = Math.max(0, Math.min(100, Math.round(((awardedMarks / possibleMarks) * 100) * 100) / 100));
  const existingProgress = await UserCourseProgress.findOne({
    userId: new mongoose.Types.ObjectId(options.userId),
    courseId: new mongoose.Types.ObjectId(options.courseId),
  }).lean();
  const lessonStatus = existingProgress?.lessonStatus || "incomplete";
  const progress = Number(existingProgress?.progress || 0);

  await UserCourseProgress.findOneAndUpdate(
    {
      userId: new mongoose.Types.ObjectId(options.userId),
      courseId: new mongoose.Types.ObjectId(options.courseId),
    },
    {
      $set: {
        score: percentage,
        lessonStatus,
        progress,
        lastAccessed: new Date(),
      },
      $setOnInsert: {
        attempts: 1,
      },
    },
    {
      upsert: true,
      runValidators: true,
    }
  );

  await syncEnrollmentProgress({
    userId: options.userId,
    courseId: options.courseId,
    lessonStatus,
    progress,
  });

  return {
    score: awardedMarks,
    maxScore: possibleMarks,
    percentage,
  };
}

export function serializeCourseQuizAttemptAsAnswerSection(attempt: any, metadata: { courseTitle?: string } = {}) {
  const answers = Array.isArray(attempt?.answers) ? attempt.answers : [];

  return {
    _id: stringifyId(attempt?._id),
    userId: stringifyId(attempt?.userId),
    courseId: stringifyId(attempt?.courseId),
    moduleId: normalizeString(attempt?.moduleId) || (attempt?.scope === "final" ? "final" : "module"),
    sectionId: normalizeString(attempt?.quizId),
    courseTitle: metadata.courseTitle || "",
    moduleTitle: normalizeString(attempt?.moduleTitle) || (attempt?.scope === "final" ? "Final Quiz" : "Module Quiz"),
    sectionTitle: normalizeString(attempt?.quizTitle) || "Course Quiz",
    lessonStatus: "completed",
    score: normalizeNumber(attempt?.percentage, null),
    lessonLocation: "",
    suspendData: "",
    rawSuspendData: "",
    totalTime: "00:00:00",
    attempts: Number(attempt?.attemptNumber || 1),
    lastAccessed: attempt?.submittedAt || attempt?.updatedAt || null,
    updatedAt: attempt?.updatedAt || null,
    createdAt: attempt?.createdAt || null,
    totalQuestions: Number(attempt?.questionCount || answers.length),
    correctCount: Number(attempt?.correctCount || 0),
    incorrectCount: Number(attempt?.incorrectCount || 0),
    reviewSummary: {
      pending: 0,
      reviewed: answers.length,
    },
    awardedMarks: Number(attempt?.score || 0),
    possibleMarks: Number(attempt?.maxScore || 0),
    interactions: answers.map((answer: any, index: number) => ({
      _id: stringifyId(answer?._id) || `${stringifyId(attempt?._id)}-${normalizeString(answer?.questionId)}`,
      uniqueKey: [
        stringifyId(attempt?.courseId),
        normalizeString(attempt?.moduleId),
        normalizeString(attempt?.quizId),
        normalizeString(answer?.questionId),
      ].filter(Boolean).join("-"),
      index,
      id: normalizeString(answer?.questionId) || `question-${index + 1}`,
      type: "choice",
      question: normalizeString(answer?.question),
      questionTitle: normalizeString(answer?.question),
      questionPrompt: normalizeString(answer?.question),
      questionAssetPaths: [],
      questionBankMatched: true,
      learnerResponse: normalizeString(answer?.selectedOptionLabel || answer?.selectedAnswerText),
      learnerResponseRaw: normalizeString(answer?.selectedOptionId),
      learnerResponseText: normalizeString(answer?.selectedAnswerText),
      correctResponses: [normalizeString(answer?.correctOptionLabel)].filter(Boolean),
      correctResponsesRaw: [normalizeString(answer?.correctOptionId)].filter(Boolean),
      correctResponseTexts: [normalizeString(answer?.correctAnswerText)].filter(Boolean),
      result: answer?.isCorrect ? "correct" : "incorrect",
      latency: "",
      time: attempt?.submittedAt || attempt?.updatedAt || "",
      maxMarks: Number(answer?.maxMarks || 0),
      source: "course_quiz",
      isReviewable: false,
      review: {
        status: "reviewed",
        evaluation: answer?.isCorrect ? "correct" : "incorrect",
        marks: Number(answer?.marksAwarded || 0),
        reviewedBy: null,
        reviewedAt: attempt?.submittedAt || attempt?.updatedAt || null,
      },
    })),
  };
}

export const previewCourseQuizExcelService = async (req: any, res: Response, next: NextFunction) => {
  try {
    if (!req.file?.buffer) {
      throw generateError("Quiz Excel file is required", 400);
    }

    const quiz = await parseCourseQuizExcel(req.file.buffer);
    return res.status(200).send({
      status: "success",
      message: "Quiz Excel parsed successfully",
      data: quiz,
    });
  } catch (err: any) {
    next(err);
  }
};

export const getLearnerCourseQuizzesService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = stringifyId(req.userId || req.bodyData?._id || req.user?._id);
    const courseId = normalizeObjectId(req.params.courseId, "courseId");

    if (!userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    await assertEnrollmentAccess(userId, courseId, req);

    const course = await Course.findById(courseId).lean();
    if (!course) {
      throw generateError("Course not found", 404);
    }

    const quizDefinitions = extractCourseQuizDefinitions(course);
    const attempts = quizDefinitions.length
      ? await CourseQuizAttempt.find({
          userId: new mongoose.Types.ObjectId(userId),
          courseId: new mongoose.Types.ObjectId(courseId),
          quizId: { $in: quizDefinitions.map((quiz) => quiz.quizId) },
        }).lean()
      : [];
    const attemptMap = new Map(attempts.map((attempt: any) => [normalizeString(attempt.quizId), attempt]));

    return res.status(200).send({
      status: "success",
      message: "Course quizzes fetched successfully",
      data: quizDefinitions.map((quiz) => serializeQuizForLearner(quiz, userId, courseId, attemptMap.get(quiz.quizId))),
    });
  } catch (err: any) {
    next(err);
  }
};

export const submitLearnerCourseQuizService = async (req: any, res: Response, next: NextFunction) => {
  try {
    const userId = stringifyId(req.userId || req.bodyData?._id || req.user?._id);
    const courseId = normalizeObjectId(req.params.courseId, "courseId");
    const quizId = normalizeString(req.params.quizId);

    if (!userId) {
      throw generateError("Authenticated user context is required", 401);
    }

    await assertEnrollmentAccess(userId, courseId, req);

    const course = await Course.findById(courseId).lean();
    if (!course) {
      throw generateError("Course not found", 404);
    }

    const quizDefinitions = extractCourseQuizDefinitions(course);
    const quiz = quizDefinitions.find((entry) => entry.quizId === quizId);
    if (!quiz) {
      throw generateError("Quiz not found for this course", 404);
    }

    const incomingAnswers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const answerMap = new Map(
      incomingAnswers.map((answer: any) => [normalizeString(answer?.questionId), normalizeString(answer?.selectedOptionId)])
    );
    const missingQuestion = quiz.questions.find((question) => !answerMap.get(question.questionId));
    if (missingQuestion) {
      throw generateError("Please answer every quiz question before submitting", 422);
    }

    const answers = quiz.questions.map((question) => {
      const selectedOptionId = answerMap.get(question.questionId) || "";
      const selectedOption = question.options.find((option) => option.optionId === selectedOptionId);
      const correctOption = question.options.find((option) => option.isCorrect);
      const isCorrect = Boolean(selectedOption && correctOption && selectedOption.optionId === correctOption.optionId);
      const maxMarks = normalizeMarks(question.marks);

      return {
        questionId: question.questionId,
        question: question.question,
        selectedOptionId,
        selectedOptionLabel: selectedOption?.label || "",
        selectedAnswerText: selectedOption?.text || "",
        correctOptionId: correctOption?.optionId || question.correctOptionId,
        correctOptionLabel: correctOption?.label || question.correctOptionLabel,
        correctAnswerText: correctOption?.text || "",
        isCorrect,
        marksAwarded: isCorrect ? maxMarks : 0,
        maxMarks,
      };
    });

    const score = answers.reduce((total, answer) => total + Number(answer.marksAwarded || 0), 0);
    const maxScore = answers.reduce((total, answer) => total + Number(answer.maxMarks || 0), 0);
    const correctCount = answers.filter((answer) => answer.isCorrect).length;
    const incorrectCount = answers.length - correctCount;
    const percentage = maxScore > 0 ? Math.round(((score / maxScore) * 100) * 100) / 100 : 0;

    const existingAttempt = await CourseQuizAttempt.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      courseId: new mongoose.Types.ObjectId(courseId),
      quizId: quiz.quizId,
    }).select("attemptNumber").lean();

    const attempt = await CourseQuizAttempt.findOneAndUpdate(
      {
        userId: new mongoose.Types.ObjectId(userId),
        courseId: new mongoose.Types.ObjectId(courseId),
        quizId: quiz.quizId,
      },
      {
        $set: {
          quizTitle: quiz.title,
          scope: quiz.scope,
          moduleId: quiz.moduleId,
          moduleTitle: quiz.moduleTitle,
          score,
          maxScore,
          percentage,
          correctCount,
          incorrectCount,
          questionCount: answers.length,
          attemptNumber: Number(existingAttempt?.attemptNumber || 0) + 1,
          answers,
          submittedAt: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    ).lean();

    const aggregateScore = await syncCourseQuizScore({ userId, courseId });

    return res.status(200).send({
      status: "success",
      message: "Quiz submitted successfully",
      data: {
        attempt: serializeAttemptForLearner(attempt),
        aggregateScore,
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export async function getCourseQuizAnswerSectionsForUser(options: { userId: string; courseId?: string }) {
  const query: any = {
    userId: new mongoose.Types.ObjectId(options.userId),
  };

  if (options.courseId) {
    query.courseId = new mongoose.Types.ObjectId(options.courseId);
  }

  const attempts = await CourseQuizAttempt.find(query).sort({ updatedAt: -1 }).lean();
  if (!attempts.length) {
    return [];
  }

  const courseIds = Array.from(new Set(attempts.map((attempt: any) => stringifyId(attempt.courseId)).filter(Boolean)));
  const courses = await Course.find({
    _id: { $in: courseIds.map((courseId) => new mongoose.Types.ObjectId(courseId)) },
  }).select("title").lean();
  const courseTitleMap = new Map(courses.map((course: any) => [stringifyId(course._id), normalizeString(course.title)]));

  return attempts.map((attempt: any) =>
    serializeCourseQuizAttemptAsAnswerSection(attempt, {
      courseTitle: courseTitleMap.get(stringifyId(attempt.courseId)) || "",
    })
  );
}

export async function summarizeCourseQuizAttemptsForUser(options: { userId: string; courseIds: string[] }) {
  const courseIds = options.courseIds.filter((courseId) => mongoose.Types.ObjectId.isValid(courseId));
  if (!courseIds.length) {
    return new Map<string, { total: number; pending: number; reviewed: number }>();
  }

  const attempts = await CourseQuizAttempt.find({
    userId: new mongoose.Types.ObjectId(options.userId),
    courseId: { $in: courseIds.map((courseId) => new mongoose.Types.ObjectId(courseId)) },
  }).lean();
  const summaryMap = new Map<string, { total: number; pending: number; reviewed: number }>();

  attempts.forEach((attempt: any) => {
    const key = stringifyId(attempt.courseId);
    const current = summaryMap.get(key) || { total: 0, pending: 0, reviewed: 0 };
    current.total += Number(attempt.questionCount || 0);
    current.reviewed += Number(attempt.questionCount || 0);
    summaryMap.set(key, current);
  });

  return summaryMap;
}
