/**
 * scormQuestionBank.service.ts
 *
 * Extracts question metadata from iSpring SCORM packages and persists them in
 * the ScormQuestionBank collection.  Also provides helpers to enrich learner
 * interactions (from cmi.interactions) with the extracted question prompts.
 *
 * ── Why this exists ──
 * cmi.interactions gives learner response/result data at runtime, but does NOT
 * include the actual displayed question prompt.  Question text lives inside the
 * authored SCORM package metadata (res/data/quiz*.js → base64 quizInfo).
 *
 * The existing extraction pipeline in scormStorage.service.ts already handles
 * parsing at upload time and stores metadata on the course document.  This
 * service persists the same data into a dedicated, queryable MongoDB collection
 * (ScormQuestionBank) so that:
 *   1. Questions can be queried/filtered independently of course documents.
 *   2. Interaction enrichment can work by loading the question bank for a given
 *      scormPackageId without traversing the full course document tree.
 *   3. Re-extraction is idempotent via upserts keyed on
 *      (scormPackageId, interactionIdPart).
 */

import ScormQuestionBank, {
  IScormQuestionBank,
  IScormQuestionBankChoice,
  ScormQuestionExtractionStatus,
  ScormQuestionSource,
} from "../../schemas/course/ScormQuestionBank";
import {
  getScormAssetSlideMetadata,
  ScormQuestionMetadata,
  isLikelyInternalId,
} from "./scormStorage.service";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type ProcessScormQuestionBankOptions = {
  courseId: string;
  moduleId?: string;
  sectionId?: string;
  scormPackageId: string;
  supabasePath: string;
};

export type EnrichableInteraction = {
  id?: string;
  type?: string;
  question?: string;
  learnerResponse?: string;
  correctResponses?: string[];
  result?: string;
  latency?: string;
  time?: string;
  maxMarks?: number | null;
  [key: string]: any;
};

export type EnrichedInteraction = EnrichableInteraction & {
  questionTitle?: string;
  questionPrompt?: string | null;
  questionAssetPaths?: string[];
  questionBankMatched?: boolean;
  learnerResponseRaw?: string;
  learnerResponseText?: string | null;
  correctResponsesRaw?: string[];
  correctResponseTexts?: string[];
};

type EnrichInteractionOptions = {
  interactions: EnrichableInteraction[];
  scormPackageId: string;
  courseId?: string;
  moduleId?: string;
  sectionId?: string;
};

type ScormPackageContext = {
  previewUrl?: string | null;
  scormFilePath?: string | null;
  supabasePath?: string | null;
  resourceUrl?: string | null;
} | null | undefined;

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeString(value)).filter(Boolean)));
}

function isUsefulText(value: unknown): boolean {
  const text = normalizeString(value);
  return text.length > 2 && /[A-Za-z]/.test(text);
}

function normalizeResponseToken(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function splitResponseValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitResponseValues(entry));
  }

  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return [];
  }

  return normalizedValue
    .split(/[,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildResponseKey(index: number) {
  return `${index}_`;
}

function looksLikeOpaqueResponseValue(value: string) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return false;
  }

  return (
    /^[0-9_]+$/.test(normalizedValue) ||
    /^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(normalizedValue) ||
    /^choice[-_a-z0-9]+$/i.test(normalizedValue)
  );
}

function extractPackageIdFromPath(value: unknown) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return "";
  }

  let pathname = normalizedValue;
  try {
    if (/^https?:\/\//i.test(normalizedValue)) {
      pathname = new URL(normalizedValue).pathname;
    }
  } catch (error) {
    pathname = normalizedValue;
  }

  pathname = pathname.split(/[?#]/)[0] || pathname;

  const uuidMatch = pathname.match(
    /(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/i
  );
  if (uuidMatch?.[1]) {
    return normalizeString(uuidMatch[1]);
  }

  const segments = pathname.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) {
    return "";
  }

  const resIndex = segments.findIndex((segment) => segment.toLowerCase() === "res");
  if (resIndex > 0) {
    return normalizeString(segments[resIndex - 1]);
  }

  return normalizeString(segments[0]);
}

export function extractScormPackageIdFromSectionContext(sectionContext: ScormPackageContext) {
  const sources = [
    sectionContext?.previewUrl,
    sectionContext?.scormFilePath,
    sectionContext?.supabasePath,
    sectionContext?.resourceUrl,
  ];

  for (const source of sources) {
    const packageId = extractPackageIdFromPath(source);
    if (packageId) {
      return packageId;
    }
  }

  return "";
}

/**
 * Derive a human-readable question title from an iSpring-style interaction ID.
 *
 * Example:
 *   Slide6_Q_2mxl1mff5xlw-mrqgotadctue_Time_For_Reflection
 *   → "Time For Reflection"
 */
function deriveQuestionTitleFromId(interactionId: string): string {
  const normalizedId = normalizeString(interactionId);
  const match = normalizedId.match(
    /^Slide\d+_Q_[a-z0-9]+-[a-z0-9]+_(.+)$/i
  );
  if (!match?.[1]) {
    return "";
  }

  return match[1]
    .replace(/_+$/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Determine the extraction status and source classification for a question.
 */
function classifyQuestion(metadata: ScormQuestionMetadata): {
  source: ScormQuestionSource;
  extractionStatus: ScormQuestionExtractionStatus;
} {
  const hasImages = metadata.imageAssetPaths.length > 0;
  const hasText = isUsefulText(metadata.question);
  const hasTextChoices =
    metadata.choices.length > 0 &&
    metadata.choices.some((choice) => isUsefulText(choice.text));

  if (!hasText && hasImages) {
    return {
      source: hasTextChoices ? "mixed" : "image",
      extractionStatus: "image_based_question",
    };
  }

  if (hasText && hasImages) {
    return {
      source: "mixed",
      extractionStatus: "extracted",
    };
  }

  if (!hasText && !hasImages) {
    return {
      source: "quizInfo",
      extractionStatus: "partial",
    };
  }

  return {
    source: "quizInfo",
    extractionStatus: "extracted",
  };
}

/**
 * Build a ScormQuestionBank document payload from parsed question metadata.
 */
function buildQuestionBankRecord(
  metadata: ScormQuestionMetadata,
  options: ProcessScormQuestionBankOptions,
  quizFilePath: string
): Partial<IScormQuestionBank> {
  const { source, extractionStatus } = classifyQuestion(metadata);

  const choices: IScormQuestionBankChoice[] = metadata.choices.map((choice, index) => {
    const choiceIndex = Number.isFinite(Number(choice.index)) ? Number(choice.index) : index;
    const rawId = normalizeString(choice.id);
    const responseKey = buildResponseKey(choiceIndex);

    return {
      id: rawId || responseKey,
      rawId,
      index: choiceIndex,
      responseKey,
      responseAliases: uniqueStrings([rawId, String(choiceIndex), responseKey]),
      text: normalizeString(choice.text),
      isCorrect: Boolean(choice.isCorrect),
    };
  });

  const correctChoices = metadata.correctResponses.map((r) =>
    normalizeString(r)
  );

  const questionPrompt = isUsefulText(metadata.questionPrompt)
    ? normalizeString(metadata.questionPrompt)
    : isUsefulText(metadata.question)
    ? normalizeString(metadata.question)
    : null;

  // The primary alias is the questionId from the quiz payload.
  // For iSpring, this looks like "2mxl1mff5xlw-mrqgotadctue".
  const interactionIdPart = normalizeString(metadata.questionId);

  // Build a human-readable title from the first interaction alias.
  const primaryAlias = metadata.interactionIds[0] || "";
  const derivedTitle = deriveQuestionTitleFromId(primaryAlias);
  
  let questionTitle = metadata.question || derivedTitle || "";
  let finalQuestionPrompt = questionPrompt;
  let finalExtractionStatus = extractionStatus;

  if (isLikelyInternalId(questionTitle)) {
    questionTitle = "";
  }
  
  if (!questionTitle && !finalQuestionPrompt && metadata.imageAssetPaths.length > 0) {
    finalExtractionStatus = "image_based_question";
  }

  // Populate slide and quiz number from metadata
  const slideNumber = metadata.slideNumber !== undefined ? metadata.slideNumber : null;
  const quizNumber = metadata.quizIndex !== undefined ? metadata.quizIndex : null;

  return {
    courseId: options.courseId as any,
    moduleId: options.moduleId || "",
    sectionId: options.sectionId || "",
    scormPackageId: options.scormPackageId,
    supabasePath: options.supabasePath,
    quizFile: quizFilePath,
    slideNumber,
    quizNumber,
    interactionIdPart,
    questionType: normalizeString(metadata.type),
    questionTitle: questionTitle || "",
    questionPrompt: finalQuestionPrompt,
    choices,
    correctChoices,
    imagePaths: metadata.imageAssetPaths,
    source,
    extractionStatus: finalExtractionStatus,
    rawQuestionData: {
      questionId: metadata.questionId,
      interactionId: metadata.interactionId,
      interactionIds: metadata.interactionIds,
      slideNumber: metadata.slideNumber,
      quizIndex: metadata.quizIndex,
      questionIndex: metadata.questionIndex,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Core Service Functions
// ────────────────────────────────────────────────────────────────────────────

/**
 * Process a SCORM package and extract its question bank.
 *
 * This function:
 * 1. Reads the existing slide metadata (which triggers quiz*.js parsing).
 * 2. Converts each ScormQuestionMetadata entry into a ScormQuestionBank record.
 * 3. Upserts into MongoDB with a unique key of (scormPackageId, interactionIdPart).
 *
 * It reuses the existing parsing infrastructure from scormStorage.service.ts
 * (getScormAssetSlideMetadata → extractISpringQuestionMetadata) rather than
 * duplicating the zip download / extraction logic, because the package is
 * already extracted and available (either locally or via Supabase) by the time
 * this function is called after upload.
 */
export async function processScormQuestionBank(
  options: ProcessScormQuestionBankOptions
): Promise<{
  totalExtracted: number;
  totalFailed: number;
  questions: Partial<IScormQuestionBank>[];
}> {
  const { supabasePath, scormPackageId } = options;

  if (!supabasePath || !scormPackageId) {
    console.warn(
      "[ScormQuestionBank] Missing supabasePath or scormPackageId, skipping extraction."
    );
    return { totalExtracted: 0, totalFailed: 0, questions: [] };
  }

  console.log(
    `[ScormQuestionBank] Starting extraction for package ${scormPackageId} at ${supabasePath}`
  );

  let slideMetadata;
  try {
    slideMetadata = await getScormAssetSlideMetadata(supabasePath, {
      includeQuestions: true,
    });
  } catch (error) {
    console.error(
      `[ScormQuestionBank] Failed to load slide metadata for ${supabasePath}:`,
      error
    );
    return { totalExtracted: 0, totalFailed: 0, questions: [] };
  }

  if (!slideMetadata || !slideMetadata.questions.length) {
    console.log(
      `[ScormQuestionBank] No questions found in package ${scormPackageId}.`
    );
    return { totalExtracted: 0, totalFailed: 0, questions: [] };
  }

  console.log(
    `[ScormQuestionBank] Found ${slideMetadata.questions.length} question(s) in package ${scormPackageId}.`
  );

  let totalExtracted = 0;
  let totalFailed = 0;
  const savedQuestions: Partial<IScormQuestionBank>[] = [];

  for (const questionMetadata of slideMetadata.questions) {
    const interactionIdPart = normalizeString(questionMetadata.questionId);
    if (!interactionIdPart) {
      console.warn(
        "[ScormQuestionBank] Skipping question with empty questionId."
      );
      totalFailed += 1;
      continue;
    }

    const record = buildQuestionBankRecord(
      questionMetadata,
      options,
      normalizeString(questionMetadata.sourceAssetPath)
    );

    try {
      await ScormQuestionBank.findOneAndUpdate(
        {
          scormPackageId: options.scormPackageId,
          slideNumber: record.slideNumber || null,
          interactionIdPart,
        },
        { $set: record },
        { upsert: true, new: true, runValidators: true }
      );

      totalExtracted += 1;
      savedQuestions.push(record);
    } catch (error) {
      console.error(
        `[ScormQuestionBank] Failed to upsert question ${interactionIdPart}:`,
        error
      );
      totalFailed += 1;
    }
  }

  console.log(
    `[ScormQuestionBank] Extraction complete for ${scormPackageId}: ` +
      `${totalExtracted} extracted, ${totalFailed} failed.`
  );

  return { totalExtracted, totalFailed, questions: savedQuestions };
}

// ────────────────────────────────────────────────────────────────────────────
// Interaction Enrichment
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the internal question ID from a runtime interaction ID.
 *
 * iSpring interaction IDs follow a pattern like:
 *   Slide6_Q_2mxl1mff5xlw-mrqgotadctue_Time_For_Reflection
 *
 * We need to find that "2mxl1mff5xlw-mrqgotadctue" is the internal question
 * ID.  This function extracts it using a regex.
 */
export function normalizeInteractionQuestionId(interactionId: string): string {
  const normalizedId = normalizeString(interactionId);

  // iSpring pattern: Slide{N}_Q_{questionId}_{ReadableText}
  const match = normalizedId.match(/^Slide\d+_Q_([^_]+)/i);
  if (match?.[1]) {
    return normalizeString(match[1]);
  }

  return normalizedId;
}

function parseInteractionSlideNumber(interactionId: string) {
  const match = normalizeString(interactionId).match(/^Slide(\d+)_/i);
  return match ? Number(match[1]) : null;
}

function buildQuestionBankQueries(options: {
  scormPackageId: string;
  courseId?: string;
  moduleId?: string;
  sectionId?: string;
}) {
  const queries: Array<{ label: string; filter: Record<string, any> }> = [];
  const courseId = normalizeString(options.courseId);
  const moduleId = normalizeString(options.moduleId);
  const sectionId = normalizeString(options.sectionId);

  if (courseId && moduleId && sectionId) {
    queries.push({
      label: "scoped",
      filter: {
        scormPackageId: options.scormPackageId,
        courseId,
        moduleId,
        sectionId,
      },
    });
  }

  if (courseId) {
    queries.push({
      label: "course",
      filter: {
        scormPackageId: options.scormPackageId,
        courseId,
      },
    });
  }

  queries.push({
    label: "package",
    filter: {
      scormPackageId: options.scormPackageId,
    },
  });

  return queries;
}

async function loadQuestionBankRecords(options: {
  scormPackageId: string;
  courseId?: string;
  moduleId?: string;
  sectionId?: string;
}) {
  const queries = buildQuestionBankQueries(options);

  for (const query of queries) {
    const records = await ScormQuestionBank.find(query.filter).lean();
    console.log("[ScormQuestionBank] Loaded candidate records", {
      scormPackageId: options.scormPackageId,
      courseId: normalizeString(options.courseId),
      moduleId: normalizeString(options.moduleId),
      sectionId: normalizeString(options.sectionId),
      queryLabel: query.label,
      recordCount: records.length,
    });

    if (records.length > 0) {
      return {
        queryLabel: query.label,
        records,
      };
    }
  }

  return {
    queryLabel: queries[queries.length - 1]?.label || "package",
    records: [] as IScormQuestionBank[],
  };
}

function findChoiceForResponse(
  response: string,
  choices: IScormQuestionBankChoice[]
): IScormQuestionBankChoice | undefined {
  const normalizedResponse = normalizeResponseToken(response);
  if (!normalizedResponse) {
    return undefined;
  }

  return choices.find((choice) => {
    const aliases = uniqueStrings([
      choice.id,
      choice.rawId,
      choice.responseKey,
      ...(Array.isArray(choice.responseAliases) ? choice.responseAliases : []),
      String(choice.index),
    ]).map((alias) => normalizeResponseToken(alias));

    return aliases.includes(normalizedResponse);
  });
}

function buildResponseDisplay(values: unknown, choices: IScormQuestionBankChoice[]) {
  const rawParts = splitResponseValues(values);
  const displayParts: string[] = [];
  let mapped = false;

  rawParts.forEach((rawPart) => {
    const matchedChoice = findChoiceForResponse(rawPart, choices);
    if (matchedChoice && normalizeString(matchedChoice.text)) {
      mapped = true;
      displayParts.push(normalizeString(matchedChoice.text));
      return;
    }

    if (isUsefulText(rawPart) && !looksLikeOpaqueResponseValue(rawPart)) {
      displayParts.push(normalizeString(rawPart));
    }
  });

  return {
    rawParts,
    displayParts: uniqueStrings(displayParts),
    mapped,
  };
}

function matchQuestionBankRecord(
  interactionId: string,
  slideNumber: number | null,
  interactionIdPart: string,
  records: IScormQuestionBank[]
) {
  const normalizedId = normalizeString(interactionId);
  const normalizedInteractionIdPart = normalizeString(interactionIdPart);

  const exactMatches = records.filter(
    (record) => normalizeString(record.interactionIdPart) === normalizedInteractionIdPart
  );
  const includesMatches = records.filter((record) => {
    const recordIdPart = normalizeString(record.interactionIdPart);
    return recordIdPart ? normalizedId.includes(recordIdPart) : false;
  });
  const candidateMatches = exactMatches.length ? exactMatches : includesMatches;

  if (!candidateMatches.length) {
    return {
      candidateMatches,
      matched: undefined as IScormQuestionBank | undefined,
    };
  }

  const slideMatched =
    slideNumber === null
      ? undefined
      : candidateMatches.find((record) => record.slideNumber === slideNumber);

  return {
    candidateMatches,
    matched: slideMatched || candidateMatches[0],
  };
}

/**
 * Enrich learner interactions by matching against the ScormQuestionBank.
 *
 * Matching logic:
 * - The interaction ID may look like:
 *     Slide6_Q_2mxl1mff5xlw-mrqgotadctue_Time_For_Reflection
 * - The extracted question bank record has interactionIdPart:
 *     2mxl1mff5xlw-mrqgotadctue
 * - Matching checks whether the interaction ID *includes* the extracted
 *   interactionIdPart (not exact equality).
 *
 * For performance, all question bank records for the package are loaded once
 * and matched in memory.
 */
export async function enrichInteractionWithQuestionBank(
  options: EnrichInteractionOptions
): Promise<EnrichedInteraction[]> {
  const {
    interactions,
    scormPackageId,
    courseId,
    moduleId,
    sectionId,
  } = options;

  if (!interactions.length || !scormPackageId) {
    return interactions;
  }

  try {
    const { records: questionBankRecords, queryLabel } = await loadQuestionBankRecords({
      scormPackageId,
      courseId,
      moduleId,
      sectionId,
    });

    if (!questionBankRecords.length) {
      console.warn("[ScormQuestionBank] No question bank records found for enrichment", {
        scormPackageId,
        courseId: normalizeString(courseId),
        moduleId: normalizeString(moduleId),
        sectionId: normalizeString(sectionId),
      });
      return interactions;
    }

    return interactions.map((interaction) => {
      const interactionId = normalizeString(interaction.id);
      const slideNumber = parseInteractionSlideNumber(interactionId);
      const interactionIdPart = normalizeInteractionQuestionId(interactionId);

      if (!interactionId) {
        console.log("[ScormQuestionBank] Enrichment debug", {
          interactionId: "",
          slideNumber,
          interactionIdPart,
          courseId: normalizeString(courseId),
          moduleId: normalizeString(moduleId),
          sectionId: normalizeString(sectionId),
          scormPackageId,
          queryLabel,
          candidateRecordCount: questionBankRecords.length,
          interactionCandidateMatchCount: 0,
          matchedRecordId: null,
          matchedSlideNumber: null,
          matchedInteractionIdPart: null,
          matchedQuestionTitle: null,
          learnerResponseTextMapped: false,
        });
        return interaction;
      }

      const { candidateMatches, matched } = matchQuestionBankRecord(
        interactionId,
        slideNumber,
        interactionIdPart,
        questionBankRecords
      );

      const mappedLearnerResponse = buildResponseDisplay(
        interaction.learnerResponse,
        matched?.choices || []
      );
      const mappedCorrectResponses = buildResponseDisplay(
        interaction.correctResponses || [],
        matched?.choices || []
      );

      console.log("[ScormQuestionBank] Enrichment debug", {
        interactionId,
        slideNumber,
        interactionIdPart,
        courseId: normalizeString(courseId),
        moduleId: normalizeString(moduleId),
        sectionId: normalizeString(sectionId),
        scormPackageId,
        queryLabel,
        candidateRecordCount: questionBankRecords.length,
        interactionCandidateMatchCount: candidateMatches.length,
        matchedRecordId: matched?._id ? String(matched._id) : null,
        matchedSlideNumber: matched?.slideNumber ?? null,
        matchedInteractionIdPart: matched?.interactionIdPart ?? null,
        matchedQuestionTitle: matched?.questionTitle ?? null,
        learnerResponseTextMapped: mappedLearnerResponse.mapped,
      });

      if (!matched) {
        return interaction;
      }

      const learnerResponseRaw = normalizeString(interaction.learnerResponse);
      const learnerResponseText = mappedLearnerResponse.displayParts.length
        ? mappedLearnerResponse.displayParts.join(", ")
        : null;
      const correctResponsesRaw = uniqueStrings(interaction.correctResponses || []);
      const correctResponseTexts = mappedCorrectResponses.displayParts.length
        ? mappedCorrectResponses.displayParts
        : [];

      return {
        ...interaction,
        questionTitle:
          normalizeString(matched.questionTitle) ||
          normalizeString(matched.questionPrompt) ||
          interaction.question ||
          "",
        questionPrompt: matched.questionPrompt || interaction.questionPrompt || null,
        questionAssetPaths: matched.imagePaths || [],
        questionBankMatched: true,
        learnerResponse: learnerResponseText || learnerResponseRaw,
        learnerResponseRaw,
        learnerResponseText,
        correctResponses: correctResponseTexts.length ? correctResponseTexts : correctResponsesRaw,
        correctResponsesRaw,
        correctResponseTexts,
      };
    });
  } catch (error) {
    console.error(
      `[ScormQuestionBank] Failed to load question bank for package ${scormPackageId}:`,
      error
    );
    return interactions;
  }
}

/**
 * Enrich a single interaction with question bank data.
 * Convenience wrapper for enriching one interaction at a time.
 */
export async function enrichSingleInteraction(
  interaction: EnrichableInteraction,
  scormPackageId: string
): Promise<EnrichedInteraction> {
  const [enriched] = await enrichInteractionWithQuestionBank({
    interactions: [interaction],
    scormPackageId,
  });

  return enriched;
}

/**
 * Get all question bank records for a specific course.
 */
export async function getQuestionBankForCourse(
  courseId: string
): Promise<IScormQuestionBank[]> {
  return ScormQuestionBank.find({ courseId }).sort({ quizFile: 1 }).lean();
}

/**
 * Get all question bank records for a specific SCORM package.
 */
export async function getQuestionBankForPackage(
  scormPackageId: string
): Promise<IScormQuestionBank[]> {
  return ScormQuestionBank.find({ scormPackageId }).sort({ quizFile: 1 }).lean();
}
