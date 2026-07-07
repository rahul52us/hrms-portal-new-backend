const LZString: any = require("../../../node_modules/lz-string/libs/lz-string.js");
import { normalizeScore, normalizeString, stringifyId } from "./scormTracking.helpers";
import type { ScormQuestionMetadata, ScormQuestionChoiceMetadata } from "./scormStorage.service";

export type ScormReviewStatus = "pending" | "reviewed";
export type ScormReviewEvaluation = "correct" | "incorrect";
export type ScormInteractionSource = "cmi.interactions" | "suspend_data";
const REVIEWABLE_INTERACTION_MAX_MARKS = 10;
const GENERIC_QUESTION_ID_TOKENS = new Set([
  "question",
  "questions",
  "interaction",
  "interactions",
  "item",
  "items",
  "quiz",
  "quizzes",
  "q",
  "scorm",
  "slide",
  "slides",
]);

export type NormalizedScormTrackingInteraction = {
  index: number;
  questionNumber?: number;
  id: string;
  type: string;
  question: string;
  questionTitle?: string | null;
  questionPrompt?: string | null;
  questionAssetPaths?: string[];
  questionBankMatched?: boolean;
  learnerResponse: string;
  learnerResponseRaw?: string;
  learnerResponseText?: string | null;
  correctResponses: string[];
  correctResponsesRaw?: string[];
  correctResponseTexts?: string[];
  result: string;
  isCorrect?: boolean | null;
  score?: number | null;
  latency: string;
  time: string;
  attemptTimestamp?: string;
  maxMarks: number | null;
  source: ScormInteractionSource;
  rawData: Record<string, any>;
};

type StoredInteractionReview = {
  status: ScormReviewStatus;
  evaluation?: ScormReviewEvaluation;
  marks: number | null;
  reviewedBy: any;
  reviewedAt: Date | null;
};

type StoredInteraction = NormalizedScormTrackingInteraction & {
  _id?: any;
  review: StoredInteractionReview;
};

type SerializeScormTrackingRecordOptions = {
  courseTitle?: string;
  moduleTitle?: string;
  sectionTitle?: string;
};

type ScormQuestionMetadataLookup = {
  byInteractionId: Map<string, ScormQuestionMetadata>;
  byQuestionId: Map<string, ScormQuestionMetadata>;
  duplicateQuestionIds: Set<string>;
};

const DEFAULT_REVIEW: StoredInteractionReview = {
  status: "pending",
  marks: null,
  reviewedBy: null,
  reviewedAt: null,
};
const MANUAL_INTERACTION_TYPES = new Set([
  "essay",
  "fill-in",
  "long-fill-in",
  "long-fillin",
  "short-answer",
  "text",
]);

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeQuestionText(value: unknown) {
  return decodeHtmlEntities(
    normalizeString(value)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function isGenericQuestionLabel(value: unknown) {
  const normalizedValue = normalizeQuestionText(value).toLowerCase();
  if (!normalizedValue) {
    return false;
  }

  return (
    /^question\s*\d+\b/.test(normalizedValue) ||
    /^q\s*\d+\b/.test(normalizedValue) ||
    /^slide\s*\d+\b/.test(normalizedValue) ||
    /^interaction\s*\d+\b/.test(normalizedValue) ||
    /^item\s*\d+\b/.test(normalizedValue)
  );
}

function flattenPrimitiveValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenPrimitiveValues(entry));
  }

  if (isPlainObject(value)) {
    const directText = [
      value.text,
      value.label,
      value.value,
      value.answer,
      value.response,
      value.name,
      value.title,
      value.prompt,
      value.pattern,
    ]
      .map((entry) => normalizeString(entry))
      .filter(Boolean);

    if (directText.length) {
      return directText;
    }

    return Object.values(value).flatMap((entry) => flattenPrimitiveValues(entry));
  }

  const normalizedValue = normalizeQuestionText(value);
  return normalizedValue ? [normalizedValue] : [];
}

function toDisplayString(value: unknown) {
  return flattenPrimitiveValues(value).filter(Boolean).join(", ");
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => normalizeString(value)).filter(Boolean)));
}

function isMeaningfulQuestionText(value: unknown) {
  const normalizedValue = normalizeQuestionText(value);
  return normalizedValue.length > 8 && !isGenericQuestionLabel(normalizedValue) && !looksLikeRawInteractionId(normalizedValue);
}

function normalizeLookupKey(value: unknown) {
  return normalizeString(value).toLowerCase();
}

function getISpringQuestionIdFromInteractionId(value: unknown) {
  const normalizedId = normalizeString(value);
  const match = normalizedId.match(/^Slide\d+_Q_([^_]+)_?/i);
  return match?.[1] ? normalizeString(match[1]) : "";
}

function responseMatchesChoice(response: string, choice: ScormQuestionChoiceMetadata) {
  const normalizedResponse = normalizeLookupKey(response);
  if (!normalizedResponse) {
    return false;
  }

  return (
    normalizedResponse === normalizeLookupKey(choice.id) ||
    normalizedResponse === normalizeLookupKey(choice.text) ||
    normalizedResponse === String(choice.index).toLowerCase() ||
    normalizedResponse === `${String(choice.index).toLowerCase()}_` ||
    normalizedResponse === String(choice.index + 1).toLowerCase()
  );
}

function resolveChoiceText(response: string, choices: ScormQuestionChoiceMetadata[]) {
  const matchedChoice = choices.find((choice) => responseMatchesChoice(response, choice));
  return normalizeString(matchedChoice?.text) || "";
}

function resolveResponseWithChoices(response: string, choices: ScormQuestionChoiceMetadata[]) {
  const normalizedResponse = normalizeString(response);
  if (!normalizedResponse || !choices.length) {
    return normalizedResponse;
  }

  return normalizedResponse
    .split(/[,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => resolveChoiceText(part, choices) || part)
    .join(", ");
}

function resolveCorrectResponsesWithMetadata(
  currentResponses: string[],
  metadata: ScormQuestionMetadata | undefined
) {
  const metadataResponses = uniqueStrings(Array.isArray(metadata?.correctResponses) ? metadata.correctResponses : []);
  if (!metadataResponses.length) {
    return currentResponses;
  }

  const normalizedCurrent = uniqueStrings(currentResponses);
  const currentLooksOpaque =
    !normalizedCurrent.length ||
    normalizedCurrent.every((response) =>
      /^\d+$/.test(response) ||
      Boolean(metadata?.choices?.some((choice) => normalizeLookupKey(choice.id) === normalizeLookupKey(response)))
    );

  return currentLooksOpaque ? metadataResponses : normalizedCurrent;
}

function buildScormQuestionMetadataLookup(questionMetadata: unknown): ScormQuestionMetadataLookup {
  const entries = Array.isArray(questionMetadata) ? questionMetadata : [];
  const byInteractionId = new Map<string, ScormQuestionMetadata>();
  const byQuestionIdCandidates = new Map<string, ScormQuestionMetadata[]>();

  entries.forEach((entry: any) => {
    if (!isPlainObject(entry)) {
      return;
    }

    const metadata = entry as ScormQuestionMetadata;
    const interactionIds = uniqueStrings([
      metadata.interactionId,
      ...(Array.isArray(metadata.interactionIds) ? metadata.interactionIds : []),
    ]);

    interactionIds.forEach((interactionId) => {
      byInteractionId.set(normalizeLookupKey(interactionId), metadata);
    });

    const questionId = normalizeString(metadata.questionId);
    if (questionId) {
      const questionEntries = byQuestionIdCandidates.get(normalizeLookupKey(questionId)) || [];
      questionEntries.push(metadata);
      byQuestionIdCandidates.set(normalizeLookupKey(questionId), questionEntries);
    }
  });

  const byQuestionId = new Map<string, ScormQuestionMetadata>();
  const duplicateQuestionIds = new Set<string>();
  byQuestionIdCandidates.forEach((questionEntries, questionId) => {
    if (questionEntries.length === 1) {
      byQuestionId.set(questionId, questionEntries[0]);
    } else {
      duplicateQuestionIds.add(questionId);
    }
  });

  return {
    byInteractionId,
    byQuestionId,
    duplicateQuestionIds,
  };
}

function findScormQuestionMetadata(
  interaction: NormalizedScormTrackingInteraction,
  lookup: ScormQuestionMetadataLookup
) {
  const idKey = normalizeLookupKey(interaction.id);
  if (idKey && lookup.byInteractionId.has(idKey)) {
    return lookup.byInteractionId.get(idKey);
  }

  const questionId = getISpringQuestionIdFromInteractionId(interaction.id) || interaction.id;
  const questionIdKey = normalizeLookupKey(questionId);
  if (questionIdKey && !lookup.duplicateQuestionIds.has(questionIdKey)) {
    return lookup.byQuestionId.get(questionIdKey);
  }

  return undefined;
}

function enrichInteractionWithQuestionMetadata(
  interaction: NormalizedScormTrackingInteraction,
  lookup: ScormQuestionMetadataLookup
) {
  const metadata = findScormQuestionMetadata(interaction, lookup);
  if (!metadata) {
    return interaction;
  }

  const metadataQuestion = normalizeQuestionText(metadata.question);
  const metadataChoices = Array.isArray(metadata.choices) ? metadata.choices : [];
  const currentQuestion = normalizeQuestionText(interaction.question);
  const question = isMeaningfulQuestionText(currentQuestion) ? currentQuestion : metadataQuestion || currentQuestion;

  return {
    ...interaction,
    type: interaction.type || normalizeInteractionType(metadata.type),
    question,
    learnerResponse: resolveResponseWithChoices(interaction.learnerResponse, metadataChoices),
    correctResponses: resolveCorrectResponsesWithMetadata(interaction.correctResponses, metadata),
    maxMarks: interaction.maxMarks ?? null,
    rawData: compactRawData({
      ...interaction.rawData,
      question,
      questionAssetPaths: Array.isArray(metadata.imageAssetPaths) ? metadata.imageAssetPaths : [],
      choices: metadataChoices,
    }),
  };
}

function readFirstString(entry: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    const value = normalizeQuestionText(entry[key]);
    if (value) {
      return value;
    }
  }

  return "";
}

function getResultLabel(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "correct" : "incorrect";
  }

  const normalizedValue = normalizeString(value).toLowerCase();
  if (!normalizedValue) {
    return "";
  }

  if (normalizedValue === "wrong" || normalizedValue === "false") {
    return "incorrect";
  }

  if (normalizedValue === "true") {
    return "correct";
  }

  if (normalizedValue === "unanswered" || normalizedValue === "not answered") {
    return "unanswered";
  }

  return normalizedValue;
}

function normalizeInteractionType(value: unknown) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/_/g, "-");
}

function isManualInteractionType(value: unknown) {
  return MANUAL_INTERACTION_TYPES.has(normalizeInteractionType(value));
}

function getIsCorrect(result: unknown) {
  const normalizedResult = getResultLabel(result);
  if (normalizedResult === "correct" || normalizedResult === "passed") {
    return true;
  }
  if (normalizedResult === "incorrect" || normalizedResult === "failed") {
    return false;
  }
  return null;
}

function sanitizeLearnerResponse(value: unknown, interactionType: unknown) {
  const response = normalizeString(value);
  if (!response) {
    return "";
  }

  const normalizedResponse = response.toLowerCase();
  if (
    normalizedResponse.includes("loading") ||
    normalizedResponse === "undefined" ||
    normalizedResponse === "null" ||
    normalizedResponse === "[object object]" ||
    /^data:[^;]+;base64,/i.test(response)
  ) {
    return "";
  }

  const maxLength = isManualInteractionType(interactionType) ? 10000 : 1000;
  return response.slice(0, maxLength);
}

function getReviewStatus(value: unknown): ScormReviewStatus {
  return normalizeString(value).toLowerCase() === "reviewed" ? "reviewed" : "pending";
}

function getReviewEvaluation(value: unknown): ScormReviewEvaluation | null {
  const normalizedValue = normalizeString(value).toLowerCase();
  if (normalizedValue === "correct" || normalizedValue === "incorrect") {
    return normalizedValue;
  }

  return null;
}

function isCorrectResult(result: string) {
  const normalizedResult = normalizeString(result).toLowerCase();
  return normalizedResult === "correct" || normalizedResult === "passed";
}

function isIncorrectResult(result: string) {
  const normalizedResult = normalizeString(result).toLowerCase();
  return normalizedResult === "incorrect" || normalizedResult === "failed";
}

function buildQuestionKey(entry: Record<string, any>, index: number) {
  return (
    normalizeString(entry.questionId || entry.id || entry.identifier || entry.name || entry.key) ||
    `index:${index}`
  );
}

function hasLearnerResponse(value: unknown) {
  const normalizedValue = normalizeString(value);
  return normalizedValue.length > 0 && !normalizedValue.toLowerCase().includes("loading");
}

function shouldPersistInteraction(interaction: {
  id?: string;
  learnerResponse?: string;
  learnerResponseRaw?: string;
  result?: string;
  type?: string;
}) {
  return Boolean(
    normalizeString(interaction.id) &&
    (
      hasLearnerResponse(interaction.learnerResponseRaw || interaction.learnerResponse) ||
      normalizeString(interaction.result) ||
      normalizeString(interaction.type)
    )
  );
}

function toTitleCase(value: string) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeQuestionFromId(id: string) {
  const normalizedId = normalizeString(id);
  if (!normalizedId) {
    return "";
  }

  // iSpring-style IDs: Slide{N}_Q_{hash}-{hash}_{QuestionText}
  // Extract the readable text after the hash portion.
  const iSpringMatch = normalizedId.match(
    /^Slide\d+_Q_[a-z0-9]+-[a-z0-9]+_(.+)$/i
  );
  if (iSpringMatch?.[1]) {
    const readableText = iSpringMatch[1]
      .replace(/_+$/, "")          // strip trailing underscores
      .replace(/_/g, " ")          // underscores -> spaces
      .replace(/\s+/g, " ")
      .trim();

    if (readableText.length > 2) {
      const formatted = readableText.charAt(0).toUpperCase() + readableText.slice(1);
      const endsWithQuestionWord = /\b(what|who|why|when|where|which|how|does|is|are|can|do|will|should|could|would|by|for|mean)\s*$/i.test(formatted);
      return endsWithQuestionWord && !formatted.endsWith("?")
        ? formatted + "?"
        : formatted;
    }
  }

  const tokens = normalizedId
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => /[A-Za-z]/.test(token))
    .filter((token) => !GENERIC_QUESTION_ID_TOKENS.has(token.toLowerCase()))
    .filter((token) => !/^[a-z0-9]{6,}$/.test(token)); // Filter hash-like tokens

  if (!tokens.length) {
    return "";
  }

  return toTitleCase(tokens.join(" ").trim());
}

function normalizeQuestionFingerprint(value: unknown) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeRawInteractionId(value: string) {
  const normalized = normalizeString(value);
  if (!normalized) return false;

  // iSpring-style: Slide{N}_Q_{hash}...
  if (/^Slide\d+_Q_/i.test(normalized)) return true;

  // Generic SCORM interaction ID patterns: contains hash-like segments separated by underscores/dashes
  if (/^[A-Za-z]+\d+[_\-]/.test(normalized) && /[a-z0-9]{8,}/.test(normalized)) return true;

  return false;
}

export function formatQuestionTitle(interaction: {
  question?: string;
  id?: string;
  index?: number;
  rawData?: Record<string, any>;
}) {
  const explicitQuestion = normalizeQuestionText(interaction.question);
  if (explicitQuestion.length > 8 && !isGenericQuestionLabel(explicitQuestion) && !looksLikeRawInteractionId(explicitQuestion)) {
    return explicitQuestion;
  }

  const rawDataQuestion = extractQuestion(buildRawData(interaction.rawData || {}));
  if (rawDataQuestion.length > 8 && !isGenericQuestionLabel(rawDataQuestion)) {
    return rawDataQuestion;
  }

  const fromId = normalizeQuestionFromId(normalizeString(interaction.id));
  if (fromId.length > 3 && !isGenericQuestionLabel(fromId)) {
    return fromId;
  }

  return `Question ${Number(interaction.index || 0) + 1}`;
}

export function isReviewableInteraction(interaction: {
  type?: string;
  correctResponses?: string[];
}) {
  return isManualInteractionType(interaction.type);
}

function extractQuestion(entry: Record<string, any>) {
  const directValue = readFirstString(entry, [
    "question",
    "questionTitle",
    "questionText",
    "prompt",
    "promptText",
    "text",
    "title",
    "label",
    "description",
    "stem",
    "statement",
    "caption",
    "header",
  ]);

  if (directValue.length > 8 && !isGenericQuestionLabel(directValue)) {
    return directValue;
  }

  const queue: unknown[] = Object.values(entry || {});
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    if (!isPlainObject(current)) {
      const normalizedValue = normalizeQuestionText(current);
      if (normalizedValue.length > 12 && !isGenericQuestionLabel(normalizedValue)) {
        return normalizedValue;
      }
      continue;
    }

    const nestedDirectValue = readFirstString(current, [
      "question",
      "questionTitle",
      "questionText",
      "prompt",
      "promptText",
      "text",
      "title",
      "label",
      "description",
      "stem",
      "statement",
      "caption",
      "header",
    ]);

    if (nestedDirectValue.length > 8 && !isGenericQuestionLabel(nestedDirectValue)) {
      return nestedDirectValue;
    }

    Object.values(current).forEach((value) => queue.push(value));
  }

  return directValue;
}

function extractLearnerResponse(entry: Record<string, any>) {
  const directValue = toDisplayString(
    entry.learnerResponse ??
    entry.learner_response ??
    entry.studentResponse ??
    entry.student_response ??
    entry.response ??
    entry.answer ??
    entry.value ??
    entry.userAnswer ??
    entry.selected ??
    entry.selection ??
    entry.selectedOption ??
    entry.selectedOptions ??
    entry.responses
  );

  if (directValue) {
    return directValue;
  }

  if (Array.isArray(entry.options)) {
    return entry.options
      .filter((option) => Boolean(option?.selected || option?.isSelected || option?.checked))
      .map((option) => toDisplayString(option?.text || option?.label || option?.value || option?.answer))
      .filter(Boolean)
      .join(", ");
  }

  return "";
}

function extractCorrectResponses(entry: Record<string, any>) {
  const directResponses = uniqueStrings(
    flattenPrimitiveValues(
      entry.correctResponses ??
      entry.correct_responses ??
      entry.correctAnswer ??
      entry.correct_answer ??
      entry.correctResponse ??
      entry.correct_response ??
      entry.expectedAnswer ??
      entry.expected_answer ??
      entry.solution
    )
  );

  if (directResponses.length) {
    return directResponses;
  }

  if (Array.isArray(entry.options)) {
    return uniqueStrings(
      entry.options
        .filter((option) => Boolean(option?.correct || option?.isCorrect || option?.isAnswer))
        .map((option) => toDisplayString(option?.text || option?.label || option?.value || option?.answer))
        .filter(Boolean)
    );
  }

  return [];
}

function buildRawData(entry: unknown) {
  return isPlainObject(entry) ? entry : {};
}

function compactRawData(entry: unknown) {
  return {};
}

function resolveReadableQuestion(rawQuestion: string, id: string): string {
  if (rawQuestion.length > 8 && !isGenericQuestionLabel(rawQuestion) && !looksLikeRawInteractionId(rawQuestion)) {
    return rawQuestion;
  }
  return normalizeQuestionFromId(id);
}

function normalizeNativeInteraction(entry: any, index: number): NormalizedScormTrackingInteraction {
  const safeEntry = isPlainObject(entry) ? entry : {};
  const id = normalizeString(safeEntry.id || safeEntry.questionId);
  const type = normalizeInteractionType(safeEntry.type);
  const rawQuestion = extractQuestion(safeEntry);
  const result = getResultLabel(
    safeEntry.result ??
    safeEntry.isCorrect ??
    safeEntry.correct ??
    safeEntry.status
  );
  const learnerResponseRaw = sanitizeLearnerResponse(
    extractLearnerResponse(safeEntry),
    type
  );
  const prompt = isMeaningfulQuestionText(rawQuestion)
    ? rawQuestion
    : "";
  const correctResponses = extractCorrectResponses(safeEntry);

  return {
    index: Number.isFinite(Number(safeEntry.index)) ? Number(safeEntry.index) : index,
    questionNumber: Number.isFinite(Number(safeEntry.questionNumber))
      ? Math.max(1, Number(safeEntry.questionNumber))
      : index + 1,
    id,
    type,
    question: prompt,
    questionTitle: normalizeQuestionText(safeEntry.questionTitle || safeEntry.title) || null,
    questionPrompt: prompt || null,
    learnerResponse: learnerResponseRaw,
    learnerResponseRaw,
    learnerResponseText: learnerResponseRaw || null,
    correctResponses,
    correctResponsesRaw: correctResponses,
    correctResponseTexts: correctResponses,
    result,
    isCorrect: getIsCorrect(result),
    score: normalizeScore(safeEntry.score ?? safeEntry.marksAwarded ?? safeEntry.marks_awarded),
    latency: normalizeString(safeEntry.latency),
    time: normalizeString(safeEntry.time),
    attemptTimestamp: normalizeString(safeEntry.attemptTimestamp || safeEntry.timestamp || safeEntry.time),
    maxMarks: normalizeScore(safeEntry.weighting ?? safeEntry.maxMarks ?? safeEntry.max_marks ?? safeEntry.marks),
    source: "cmi.interactions",
    rawData: {},
  };
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function decodeSuspendDataPayload(suspendData: string) {
  const normalizedSuspendData = normalizeString(suspendData);
  if (!normalizedSuspendData) {
    return null;
  }

  const candidateStrings = [
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

  for (const candidate of candidateStrings) {
    const parsed = safeJsonParse(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function findCandidateQuizArray(rootValue: unknown): any[] {
  if (!rootValue) {
    return [];
  }

  const root = isPlainObject(rootValue) ? rootValue : {};
  const directCandidates = [
    root.quiz && isPlainObject(root.quiz) ? root.quiz.questions : null,
    root.questions,
    root.interactions,
    root.responses,
  ];

  const firstDirectCandidate = directCandidates.find((value) => Array.isArray(value));
  if (Array.isArray(firstDirectCandidate)) {
    return firstDirectCandidate;
  }

  const queue: unknown[] = [root];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((entry) => queue.push(entry));
      continue;
    }

    if (!isPlainObject(current)) {
      continue;
    }

    const nestedCandidate = [current.questions, current.interactions, current.responses].find((value) =>
      Array.isArray(value)
    );
    if (Array.isArray(nestedCandidate)) {
      return nestedCandidate;
    }

    Object.values(current).forEach((entry) => queue.push(entry));
  }

  return [];
}

function buildQuestionMetadataMap(parsedSuspendData: any) {
  const candidateQuestions = Array.isArray(parsedSuspendData?.quiz?.questions)
    ? parsedSuspendData.quiz.questions
    : Array.isArray(parsedSuspendData?.questions)
      ? parsedSuspendData.questions
      : [];

  const metadataMap = new Map<string, Partial<NormalizedScormTrackingInteraction>>();

  candidateQuestions.forEach((entry: any, index: number) => {
    const safeEntry = isPlainObject(entry) ? entry : {};
    const key = buildQuestionKey(safeEntry, index);

    metadataMap.set(key, {
      id: normalizeString(safeEntry.questionId || safeEntry.id || safeEntry.identifier || safeEntry.name || safeEntry.key),
      question: extractQuestion(safeEntry),
      correctResponses: extractCorrectResponses(safeEntry),
      maxMarks: normalizeScore(safeEntry.weighting ?? safeEntry.maxMarks ?? safeEntry.max_marks ?? safeEntry.marks),
    });
  });

  return metadataMap;
}

function normalizeSuspendDataInteraction(entry: any, index: number, metadataMap: Map<string, Partial<NormalizedScormTrackingInteraction>>) {
  const safeEntry = isPlainObject(entry) ? entry : {};
  const metadata = metadataMap.get(buildQuestionKey(safeEntry, index)) || {};
  const type = normalizeInteractionType(safeEntry.type || safeEntry.kind || safeEntry.questionType);
  const rawQuestion = normalizeString(extractQuestion(safeEntry) || metadata.question);
  const result = getResultLabel(
    safeEntry.result ??
    safeEntry.isCorrect ??
    safeEntry.correct ??
    safeEntry.status
  );
  const learnerResponseRaw = sanitizeLearnerResponse(extractLearnerResponse(safeEntry), type);
  const prompt = isMeaningfulQuestionText(rawQuestion)
    ? rawQuestion
    : "";
  const correctResponses = uniqueStrings([
    ...extractCorrectResponses(safeEntry),
    ...(Array.isArray(metadata.correctResponses) ? metadata.correctResponses : []),
  ]);

  return {
    index,
    questionNumber: index + 1,
    id: normalizeString(
      safeEntry.questionId ||
      safeEntry.id ||
      safeEntry.identifier ||
      safeEntry.name ||
      safeEntry.key ||
      metadata.id
    ),
    type,
    question: prompt,
    questionTitle: normalizeQuestionText(safeEntry.questionTitle || safeEntry.title) || null,
    questionPrompt: prompt || null,
    learnerResponse: learnerResponseRaw,
    learnerResponseRaw,
    learnerResponseText: learnerResponseRaw || null,
    correctResponses,
    correctResponsesRaw: correctResponses,
    correctResponseTexts: correctResponses,
    result,
    isCorrect: getIsCorrect(result),
    score: normalizeScore(safeEntry.score ?? safeEntry.marksAwarded ?? safeEntry.marks_awarded),
    latency: normalizeString(safeEntry.latency),
    time: normalizeString(safeEntry.time || safeEntry.timestamp),
    attemptTimestamp: normalizeString(safeEntry.timestamp || safeEntry.time),
    maxMarks: normalizeScore(
      safeEntry.weighting ??
      safeEntry.maxMarks ??
      safeEntry.max_marks ??
      safeEntry.marks ??
      metadata.maxMarks
    ),
    source: "suspend_data" as const,
    rawData: {},
  };
}

function buildSuspendDataInteractions(suspendData: string, decodedSuspendData?: any) {
  const parsedSuspendData = decodedSuspendData || decodeSuspendDataPayload(suspendData);
  if (!parsedSuspendData) {
    return [];
  }

  const metadataMap = buildQuestionMetadataMap(parsedSuspendData);
  const candidateArray = findCandidateQuizArray(parsedSuspendData);

  return candidateArray.map((entry, index) => normalizeSuspendDataInteraction(entry, index, metadataMap));
}

function enrichNativeInteractions(nativeInteractions: NormalizedScormTrackingInteraction[], fallbackInteractions: NormalizedScormTrackingInteraction[]) {
  if (!fallbackInteractions.length) {
    return nativeInteractions;
  }

  const fallbackMap = new Map<string, NormalizedScormTrackingInteraction>();
  fallbackInteractions.forEach((interaction, index) => {
    fallbackMap.set(buildInteractionMergeKey({ id: interaction.id, index: interaction.index ?? index }), interaction);
  });

  return nativeInteractions.map((interaction, index) => {
    const fallbackInteraction = fallbackMap.get(
      buildInteractionMergeKey({ id: interaction.id, index: interaction.index ?? index })
    );
    if (!fallbackInteraction) {
      return interaction;
    }

    return {
      ...interaction,
      question: interaction.question || fallbackInteraction.question,
      questionTitle: interaction.questionTitle ?? fallbackInteraction.questionTitle,
      questionPrompt: interaction.questionPrompt ?? fallbackInteraction.questionPrompt,
      questionAssetPaths: uniqueStrings([
        ...(interaction.questionAssetPaths || []),
        ...(fallbackInteraction.questionAssetPaths || []),
      ]),
      correctResponses: interaction.correctResponses.length
        ? interaction.correctResponses
        : fallbackInteraction.correctResponses,
      correctResponsesRaw: interaction.correctResponsesRaw?.length
        ? interaction.correctResponsesRaw
        : fallbackInteraction.correctResponsesRaw,
      correctResponseTexts: interaction.correctResponseTexts?.length
        ? interaction.correctResponseTexts
        : fallbackInteraction.correctResponseTexts,
      learnerResponse: interaction.learnerResponse || fallbackInteraction.learnerResponse,
      learnerResponseRaw: interaction.learnerResponseRaw || fallbackInteraction.learnerResponseRaw,
      learnerResponseText: interaction.learnerResponseText || fallbackInteraction.learnerResponseText,
      result: interaction.result || fallbackInteraction.result,
      isCorrect: interaction.isCorrect ?? fallbackInteraction.isCorrect ?? null,
      score: interaction.score ?? fallbackInteraction.score ?? null,
      latency: interaction.latency || fallbackInteraction.latency,
      time: interaction.time || fallbackInteraction.time,
      attemptTimestamp: interaction.attemptTimestamp || fallbackInteraction.attemptTimestamp,
      maxMarks: interaction.maxMarks ?? fallbackInteraction.maxMarks ?? null,
      rawData: {},
    };
  });
}

function normalizeStoredInteraction(entry: any, index: number): StoredInteraction {
  const review = isPlainObject(entry?.review) ? entry.review : {};
  const reviewStatus = getReviewStatus(review.status);
  const legacyMarks = normalizeScore(review.marksOverride);
  const marks = normalizeScore(review.marks ?? legacyMarks);
  const evaluation = getReviewEvaluation(review.evaluation);
  const storedId = normalizeString(entry?.id);
  const storedQuestion = normalizeQuestionText(entry?.question);

  return {
    _id: entry?._id,
    index: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : index,
    questionNumber: Number.isFinite(Number(entry?.questionNumber))
      ? Math.max(1, Number(entry.questionNumber))
      : index + 1,
    id: storedId,
    type: normalizeInteractionType(entry?.type),
    question: resolveReadableQuestion(storedQuestion, storedId),
    questionTitle: entry?.questionTitle,
    questionPrompt: entry?.questionPrompt,
    questionAssetPaths: Array.isArray(entry?.questionAssetPaths) ? entry.questionAssetPaths : [],
    questionBankMatched: Boolean(entry?.questionBankMatched),
    learnerResponse: normalizeString(entry?.learnerResponse),
    learnerResponseRaw: normalizeString(entry?.learnerResponseRaw) || normalizeString(entry?.learnerResponse),
    learnerResponseText: normalizeString(entry?.learnerResponseText) || null,
    correctResponses: uniqueStrings(Array.isArray(entry?.correctResponses) ? entry.correctResponses : []),
    correctResponsesRaw: uniqueStrings(
      Array.isArray(entry?.correctResponsesRaw)
        ? entry.correctResponsesRaw
        : Array.isArray(entry?.correctResponses)
          ? entry.correctResponses
          : []
    ),
    correctResponseTexts: uniqueStrings(
      Array.isArray(entry?.correctResponseTexts)
        ? entry.correctResponseTexts
        : Array.isArray(entry?.correctResponses)
          ? entry.correctResponses
          : []
    ),
    result: normalizeString(entry?.result),
    isCorrect:
      typeof entry?.isCorrect === "boolean"
        ? entry.isCorrect
        : getIsCorrect(entry?.result),
    score: normalizeScore(entry?.score),
    latency: normalizeString(entry?.latency),
    time: normalizeString(entry?.time),
    attemptTimestamp: normalizeString(entry?.attemptTimestamp || entry?.time),
    maxMarks: normalizeScore(entry?.maxMarks),
    source: normalizeString(entry?.source) === "suspend_data" ? "suspend_data" : "cmi.interactions",
    rawData: compactRawData(entry?.rawData),
    review: {
      status: reviewStatus,
      evaluation: reviewStatus === "reviewed" ? evaluation || undefined : undefined,
      marks: reviewStatus === "reviewed" ? marks : null,
      reviewedBy: review.reviewedBy || null,
      reviewedAt: review.reviewedAt || null,
    },
  };
}

function getInteractionKey(interaction: { id?: string; index?: number }) {
  return buildInteractionMergeKey(interaction);
}

function shouldResetReview(existingInteraction: StoredInteraction | undefined, incomingInteraction: NormalizedScormTrackingInteraction) {
  if (!existingInteraction) {
    return false;
  }

  const existingLearnerResponse = normalizeString(
    existingInteraction.learnerResponseRaw || existingInteraction.learnerResponse
  );
  const incomingLearnerResponse = normalizeString(
    incomingInteraction.learnerResponseRaw || incomingInteraction.learnerResponse
  );
  if (existingLearnerResponse) {
    return false;
  }
  const existingCorrectResponses = JSON.stringify(
    existingInteraction.correctResponsesRaw?.length
      ? existingInteraction.correctResponsesRaw
      : existingInteraction.correctResponses || []
  );
  const incomingCorrectResponses = JSON.stringify(
    incomingInteraction.correctResponsesRaw?.length
      ? incomingInteraction.correctResponsesRaw
      : incomingInteraction.correctResponses || []
  );

  return (
    normalizeString(existingInteraction.question) !== normalizeString(incomingInteraction.question) ||
    existingLearnerResponse !== incomingLearnerResponse ||
    normalizeString(existingInteraction.result) !== normalizeString(incomingInteraction.result) ||
    existingCorrectResponses !== incomingCorrectResponses
  );
}

function compareInteractions(left: StoredInteraction, right: StoredInteraction) {
  if (left.index !== right.index) {
    return left.index - right.index;
  }

  return normalizeString(left.id).localeCompare(normalizeString(right.id));
}

function getEffectiveResult(interaction: StoredInteraction) {
  if (isReviewableInteraction(interaction)) {
    if (interaction.review.status === "reviewed" && interaction.review.evaluation) {
      return interaction.review.evaluation;
    }

    return "";
  }

  return normalizeString(interaction.result);
}

function buildInteractionMergeKey(interaction: { id?: string; index?: number }) {
  const normalizedId = normalizeString(interaction.id);
  if (normalizedId) {
    return `id:${normalizedId.toLowerCase()}`;
  }

  const normalizedQuestion = normalizeQuestionFingerprint((interaction as any)?.question);
  if (normalizedQuestion) {
    return `question:${normalizedQuestion}`;
  }

  const normalizedIndex = Number(interaction.index || 0);
  return `index:${normalizedIndex}`;
}

function collapseStoredInteractions(interactions: StoredInteraction[]) {
  const collapsedMap = new Map<string, StoredInteraction>();

  interactions
    .slice()
    .sort(compareInteractions)
    .forEach((interaction) => {
      collapsedMap.set(getInteractionKey(interaction), interaction);
    });

  return Array.from(collapsedMap.values()).sort(compareInteractions);
}

function collapseIncomingInteractions(interactions: NormalizedScormTrackingInteraction[]) {
  const collapsedMap = new Map<string, NormalizedScormTrackingInteraction>();

  interactions
    .slice()
    .sort((left, right) => {
      if (left.index !== right.index) {
        return left.index - right.index;
      }

      return normalizeString(left.id).localeCompare(normalizeString(right.id));
    })
    .forEach((interaction) => {
      collapsedMap.set(buildInteractionMergeKey(interaction), interaction);
    });

  return Array.from(collapsedMap.values()).sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }

    return normalizeString(left.id).localeCompare(normalizeString(right.id));
  });
}

function getInteractionPossibleMarks(interaction: StoredInteraction) {
  const explicitMarks = normalizeScore(interaction.maxMarks);
  if (explicitMarks !== null && explicitMarks > 0) {
    return explicitMarks;
  }

  if (isReviewableInteraction(interaction)) {
    return REVIEWABLE_INTERACTION_MAX_MARKS;
  }

  return 1;
}

function getInteractionAwardedMarks(interaction: StoredInteraction) {
  const possibleMarks = getInteractionPossibleMarks(interaction);

  if (isReviewableInteraction(interaction)) {
    if (interaction.review.status !== "reviewed") {
      return 0;
    }

    const marks = normalizeScore(interaction.review.marks);
    if (marks === null) {
      return 0;
    }

    return Math.max(0, Math.min(possibleMarks, marks));
  }

  return isCorrectResult(getEffectiveResult(interaction)) ? possibleMarks : 0;
}

export function extractNormalizedScormInteractions(options: {
  interactions: unknown;
  suspendData: string;
  decodedSuspendData?: any;
  questionMetadata?: unknown;
}) {
  const nativeInteractions = Array.isArray(options.interactions)
    ? options.interactions.map((entry, index) => normalizeNativeInteraction(entry, index))
    : [];
  const fallbackInteractions = buildSuspendDataInteractions(options.suspendData, options.decodedSuspendData);
  const questionMetadataLookup = buildScormQuestionMetadataLookup(options.questionMetadata);

  const resolvedInteractions = nativeInteractions.length > 0
    ? enrichNativeInteractions(nativeInteractions, fallbackInteractions)
    : fallbackInteractions;
  const enrichedInteractions = resolvedInteractions.map((interaction) =>
    enrichInteractionWithQuestionMetadata(interaction, questionMetadataLookup)
  );

  return collapseIncomingInteractions(
    enrichedInteractions.filter((interaction) => shouldPersistInteraction(interaction))
  );
}

export function mergeScormTrackingInteractions(existingInteractions: unknown, incomingInteractions: NormalizedScormTrackingInteraction[]) {
  const normalizedExisting = Array.isArray(existingInteractions)
    ? existingInteractions.map((entry, index) => normalizeStoredInteraction(entry, index))
    : [];
  const persistedExisting = collapseStoredInteractions(
    normalizedExisting.filter((interaction) => shouldPersistInteraction(interaction))
  );
  const persistedIncoming = collapseIncomingInteractions(
    incomingInteractions.filter((interaction) => shouldPersistInteraction(interaction))
  );

  if (!persistedIncoming.length) {
    return persistedExisting;
  }

  const existingMap = new Map<string, StoredInteraction>();
  persistedExisting.forEach((interaction) => {
    existingMap.set(getInteractionKey(interaction), interaction);
  });

  const mergedMap = new Map<string, StoredInteraction>();
  persistedExisting.forEach((interaction) => {
    mergedMap.set(getInteractionKey(interaction), interaction);
  });

  persistedIncoming.forEach((interaction) => {
    const existingInteraction = existingMap.get(getInteractionKey(interaction));
    const shouldReset = shouldResetReview(existingInteraction, interaction);
    const mergedId = interaction.id || existingInteraction?.id || "";
    const candidateQuestion = interaction.question || existingInteraction?.question || "";
    const mergedQuestion = resolveReadableQuestion(candidateQuestion, mergedId);
    const existingLearnerResponse = normalizeString(
      existingInteraction?.learnerResponseRaw || existingInteraction?.learnerResponse
    );
    const incomingLearnerResponse = sanitizeLearnerResponse(
      interaction.learnerResponseRaw || interaction.learnerResponse,
      interaction.type || existingInteraction?.type
    );
    const mergedLearnerResponse = existingLearnerResponse || incomingLearnerResponse;

    mergedMap.set(getInteractionKey(interaction), {
      _id: existingInteraction?._id,
      index: interaction.index,
      questionNumber: interaction.questionNumber || existingInteraction?.questionNumber || interaction.index + 1,
      id: mergedId,
      type: interaction.type || existingInteraction?.type || "",
      question: mergedQuestion,
      questionTitle: interaction.questionTitle ?? existingInteraction?.questionTitle ?? null,
      questionPrompt: interaction.questionPrompt ?? existingInteraction?.questionPrompt ?? null,
      questionBankMatched: Boolean(interaction.questionBankMatched || existingInteraction?.questionBankMatched),
      questionAssetPaths: uniqueStrings([
        ...(interaction.questionAssetPaths || []),
        ...(existingInteraction?.questionAssetPaths || []),
      ]),
      learnerResponse: mergedLearnerResponse,
      learnerResponseRaw: mergedLearnerResponse,
      learnerResponseText:
        interaction.learnerResponseText ||
        existingInteraction?.learnerResponseText ||
        mergedLearnerResponse ||
        null,
      correctResponses: interaction.correctResponses.length
        ? interaction.correctResponses
        : existingInteraction?.correctResponses || [],
      correctResponsesRaw: interaction.correctResponsesRaw?.length
        ? interaction.correctResponsesRaw
        : existingInteraction?.correctResponsesRaw || [],
      correctResponseTexts: interaction.correctResponseTexts?.length
        ? interaction.correctResponseTexts
        : existingInteraction?.correctResponseTexts || [],
      result: interaction.result || existingInteraction?.result || "",
      isCorrect: interaction.isCorrect ?? existingInteraction?.isCorrect ?? null,
      score: interaction.score ?? existingInteraction?.score ?? null,
      latency: interaction.latency || existingInteraction?.latency || "",
      time: interaction.time || existingInteraction?.time || "",
      attemptTimestamp:
        interaction.attemptTimestamp ||
        existingInteraction?.attemptTimestamp ||
        interaction.time ||
        existingInteraction?.time ||
        "",
      maxMarks: interaction.maxMarks ?? existingInteraction?.maxMarks ?? null,
      source: interaction.source || existingInteraction?.source || "cmi.interactions",
      rawData: {},
      review: shouldReset
        ? { ...DEFAULT_REVIEW }
        : existingInteraction?.review || { ...DEFAULT_REVIEW },
    });
  });

  return Array.from(mergedMap.values()).sort(compareInteractions);
}

export function summarizeScormTrackingInteractions(interactions: unknown) {
  const normalizedInteractions = Array.isArray(interactions)
    ? interactions.map((entry, index) => normalizeStoredInteraction(entry, index))
    : [];
  const persistedInteractions = collapseStoredInteractions(
    normalizedInteractions.filter((interaction) => shouldPersistInteraction(interaction))
  );
  const awardedMarks = persistedInteractions.reduce(
    (total, interaction) => total + getInteractionAwardedMarks(interaction),
    0
  );
  const possibleMarks = persistedInteractions.reduce(
    (total, interaction) => total + getInteractionPossibleMarks(interaction),
    0
  );

  return {
    totalQuestions: persistedInteractions.length,
    correctCount: persistedInteractions.filter((entry) => isCorrectResult(getEffectiveResult(entry))).length,
    incorrectCount: persistedInteractions.filter((entry) => isIncorrectResult(getEffectiveResult(entry))).length,
    pendingReviewCount: persistedInteractions.filter(
      (entry) => isReviewableInteraction(entry) && entry.review.status !== "reviewed"
    ).length,
    reviewedCount: persistedInteractions.filter(
      (entry) => isReviewableInteraction(entry) && entry.review.status === "reviewed"
    ).length,
    awardedMarks,
    possibleMarks,
  };
}

function serializeReviewedBy(value: any) {
  if (!value) {
    return null;
  }

  return {
    _id: stringifyId(value?._id || value),
    name: normalizeString(value?.name),
    email: normalizeString(value?.email),
    username: normalizeString(value?.username),
  };
}

export function serializeScormTrackingRecord(trackingDoc: any, metadata: SerializeScormTrackingRecordOptions = {}) {
  const storedInteractions = Array.isArray(trackingDoc?.interactions)
    ? trackingDoc.interactions.map((entry: any, index: number) => normalizeStoredInteraction(entry, index))
    : [];
  const recoveredInteractions = extractNormalizedScormInteractions({
    interactions: [],
    suspendData: normalizeString(trackingDoc?.suspendData),
    decodedSuspendData: trackingDoc?.decoded_suspend_data,
  });
  const interactions = recoveredInteractions.length
    ? mergeScormTrackingInteractions(storedInteractions, recoveredInteractions)
    : storedInteractions;
  const persistedInteractions = collapseStoredInteractions(
    interactions.filter((interaction:any) => shouldPersistInteraction(interaction))
  );
  const summary = summarizeScormTrackingInteractions(persistedInteractions);

  return {
    _id: stringifyId(trackingDoc?._id),
    userId: stringifyId(trackingDoc?.userId),
    courseId: stringifyId(trackingDoc?.courseId),
    moduleId: normalizeString(trackingDoc?.moduleId),
    sectionId: normalizeString(trackingDoc?.sectionId),
    courseTitle: metadata.courseTitle || "",
    moduleTitle: metadata.moduleTitle || "",
    sectionTitle: metadata.sectionTitle || "",
    lessonStatus: normalizeString(trackingDoc?.lessonStatus) || "not_attempted",
    completionStatus: normalizeString(trackingDoc?.completionStatus),
    successStatus: normalizeString(trackingDoc?.successStatus),
    progressMeasure: normalizeScore(trackingDoc?.progressMeasure),
    progress: normalizeScore(trackingDoc?.progress) || 0,
    score: normalizeScore(trackingDoc?.score),
    scoreRaw: normalizeScore(trackingDoc?.scoreRaw),
    scoreScaled: normalizeScore(trackingDoc?.scoreScaled),
    scoreMin: normalizeScore(trackingDoc?.scoreMin),
    scoreMax: normalizeScore(trackingDoc?.scoreMax),
    lessonLocation: normalizeString(trackingDoc?.lessonLocation),
    totalTime: normalizeString(trackingDoc?.totalTime),
    attempts: Number(trackingDoc?.attempts || 0),
    lastAccessed: trackingDoc?.lastAccessed || null,
    updatedAt: trackingDoc?.updatedAt || null,
    createdAt: trackingDoc?.createdAt || null,
    totalQuestions: summary.totalQuestions,
    correctCount: summary.correctCount,
    incorrectCount: summary.incorrectCount,
    reviewSummary: {
      pending: summary.pendingReviewCount,
      reviewed: summary.reviewedCount,
    },
    interactions: persistedInteractions.map((interaction: StoredInteraction) => ({
      _id: stringifyId(interaction._id),
      uniqueKey: [
        stringifyId(trackingDoc?.courseId),
        normalizeString(trackingDoc?.moduleId),
        normalizeString(trackingDoc?.sectionId),
        normalizeString(interaction.id) || `index-${interaction.index}`,
      ].filter(Boolean).join("-"),
      index: interaction.index,
      questionNumber: interaction.questionNumber || interaction.index + 1,
      id: interaction.id,
      type: interaction.type,
      question: interaction.question,
      questionTitle:
        interaction.questionTitle ||
        interaction.questionPrompt ||
        interaction.question ||
        `Question ${interaction.questionNumber || interaction.index + 1}`,
      questionPrompt: interaction.questionPrompt || interaction.question || null,
      questionAssetPaths: interaction.questionAssetPaths || [],
      questionBankMatched: Boolean(interaction.questionBankMatched),
      learnerResponse: interaction.learnerResponse,
      learnerResponseRaw: interaction.learnerResponseRaw || interaction.learnerResponse,
      learnerResponseText: interaction.learnerResponseText || null,
      correctResponses: interaction.correctResponses,
      correctResponsesRaw: interaction.correctResponsesRaw?.length
        ? interaction.correctResponsesRaw
        : interaction.correctResponses,
      correctResponseTexts: interaction.correctResponseTexts?.length
        ? interaction.correctResponseTexts
        : interaction.correctResponses,
      result: interaction.result,
      isCorrect: interaction.isCorrect,
      score: interaction.score,
      latency: interaction.latency,
      time: interaction.time,
      attemptTimestamp: interaction.attemptTimestamp || interaction.time,
      maxMarks: interaction.maxMarks,
      source: interaction.source,
      isReviewable: isReviewableInteraction(interaction),
      review: {
        status: interaction.review.status,
        evaluation: interaction.review.evaluation,
        marks: interaction.review.marks,
        reviewedBy: serializeReviewedBy(interaction.review.reviewedBy),
        reviewedAt: interaction.review.reviewedAt || null,
      },
    })),
  };
}
