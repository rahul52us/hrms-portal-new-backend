import mongoose, { Document, Schema } from "mongoose";

/**
 * ScormQuestionBank – persistent, per-question metadata extracted from iSpring
 * SCORM packages (res/data/quiz*.js → base64 quizInfo → parsed JSON).
 *
 * cmi.interactions provides learner response/result data at runtime, but the
 * actual displayed question prompt and choice text live inside the authored
 * SCORM package metadata.  This model bridges the two by storing the parsed
 * question metadata alongside an `interactionIdPart` that can be matched
 * against runtime interaction IDs via a substring/includes check.
 */

export interface IScormQuestionBankChoice {
  id: string;
  rawId: string;
  index: number;
  responseKey: string;
  responseAliases: string[];
  text: string;
  isCorrect: boolean;
}

export type ScormQuestionSource = "quizInfo" | "image" | "mixed";
export type ScormQuestionExtractionStatus =
  | "extracted"
  | "image_based_question"
  | "partial"
  | "failed";

export interface IScormQuestionBank extends Document {
  courseId: mongoose.Types.ObjectId;
  moduleId: string;
  sectionId: string;
  scormPackageId: string;
  supabasePath: string;

  quizFile: string;
  slideNumber: number | null;
  quizNumber: number | null;
  interactionIdPart: string;

  questionType: string;
  questionTitle: string;
  questionPrompt: string | null;

  choices: IScormQuestionBankChoice[];
  correctChoices: string[];
  imagePaths: string[];

  source: ScormQuestionSource;
  extractionStatus: ScormQuestionExtractionStatus;

  rawQuestionData: Record<string, any> | null;

  createdAt: Date;
  updatedAt: Date;
}

const ScormQuestionBankChoiceSchema = new Schema<IScormQuestionBankChoice>(
  {
    id: { type: String, default: "" },
    rawId: { type: String, default: "" },
    index: { type: Number, default: 0, min: 0 },
    responseKey: { type: String, default: "" },
    responseAliases: { type: [String], default: [] },
    text: { type: String, default: "" },
    isCorrect: { type: Boolean, default: false },
  },
  { _id: false }
);

const ScormQuestionBankSchema = new Schema<IScormQuestionBank>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    moduleId: {
      type: String,
      default: "",
      trim: true,
    },
    sectionId: {
      type: String,
      default: "",
      trim: true,
    },
    scormPackageId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    supabasePath: {
      type: String,
      default: "",
      trim: true,
    },

    quizFile: {
      type: String,
      default: "",
      trim: true,
    },
    slideNumber: {
      type: Number,
      default: null,
    },
    quizNumber: {
      type: Number,
      default: null,
    },
    interactionIdPart: {
      type: String,
      required: true,
      trim: true,
    },

    questionType: {
      type: String,
      default: "",
      trim: true,
    },
    questionTitle: {
      type: String,
      default: "",
      trim: true,
    },
    questionPrompt: {
      type: String,
      default: null,
    },

    choices: {
      type: [ScormQuestionBankChoiceSchema],
      default: [],
    },
    correctChoices: {
      type: [String],
      default: [],
    },
    imagePaths: {
      type: [String],
      default: [],
    },

    source: {
      type: String,
      enum: ["quizInfo", "image", "mixed"],
      default: "quizInfo",
    },

    extractionStatus: {
      type: String,
      enum: ["extracted", "image_based_question", "partial", "failed"],
      default: "extracted",
    },

    rawQuestionData: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

// Unique index to avoid duplicates – upsert keyed on these fields.
ScormQuestionBankSchema.index(
  { scormPackageId: 1, slideNumber: 1, interactionIdPart: 1 },
  { unique: true }
);

// Compound index for efficient lookups when enriching interactions.
ScormQuestionBankSchema.index({ courseId: 1, scormPackageId: 1 });
ScormQuestionBankSchema.index({ scormPackageId: 1, courseId: 1, moduleId: 1, sectionId: 1 });

export default mongoose.model<IScormQuestionBank>(
  "ScormQuestionBank",
  ScormQuestionBankSchema
);
