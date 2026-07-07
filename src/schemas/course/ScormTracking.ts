import mongoose, { Document, Schema } from "mongoose";
import { ScormLessonStatus } from "./UserCourseProgress";

export type ScormInteractionSource = "cmi.interactions" | "suspend_data";
export type ScormInteractionReviewStatus = "pending" | "reviewed";
export type ScormInteractionReviewEvaluation = "correct" | "incorrect";

export interface IScormTrackingInteractionReview {
  status: ScormInteractionReviewStatus;
  evaluation?: ScormInteractionReviewEvaluation;
  marks?: number | null;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
}

export interface IScormTrackingInteraction {
  _id?: mongoose.Types.ObjectId;
  index: number;
  questionNumber?: number;
  id?: string;
  type?: string;
  question?: string;
  questionTitle?: string | null;
  questionPrompt?: string | null;
  questionAssetPaths?: string[];
  questionBankMatched?: boolean;
  learnerResponse?: string;
  learnerResponseRaw?: string;
  learnerResponseText?: string | null;
  correctResponses?: string[];
  correctResponsesRaw?: string[];
  correctResponseTexts?: string[];
  result?: string;
  isCorrect?: boolean | null;
  score?: number | null;
  latency?: string;
  time?: string;
  attemptTimestamp?: string;
  maxMarks?: number | null;
  source?: ScormInteractionSource;
  rawData?: any;
  review: IScormTrackingInteractionReview;
}

export interface IScormTracking extends Document {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  moduleId: string;
  sectionId: string;
  scormVersion?: "1.2" | "2004";
  lessonStatus: ScormLessonStatus;
  completionStatus?: string;
  successStatus?: string;
  progressMeasure?: number | null;
  progress?: number;
  score?: number | null;
  scoreRaw?: number | null;
  scoreScaled?: number | null;
  scoreMin?: number | null;
  scoreMax?: number | null;
  lessonLocation?: string;
  suspendData?: string;
  decoded_suspend_data?: any;
  sessionTime?: string;
  totalTime?: string;
  attempts: number;
  lastAccessed: Date;
  interactions: IScormTrackingInteraction[];
  createdAt: Date;
  updatedAt: Date;
}

const ScormInteractionReviewSchema = new Schema<IScormTrackingInteractionReview>(
  {
    status: {
      type: String,
      enum: ["pending", "reviewed"],
      default: "pending",
    },
    evaluation: {
      type: String,
      enum: ["correct", "incorrect"],
      default: undefined,
    },
    marks: {
      type: Number,
      default: null,
      min: 0,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const ScormTrackingInteractionSchema = new Schema<IScormTrackingInteraction>(
  {
    index: {
      type: Number,
      default: 0,
      min: 0,
    },
    questionNumber: {
      type: Number,
      default: 1,
      min: 1,
    },
    id: {
      type: String,
      default: "",
      trim: true,
    },
    type: {
      type: String,
      default: "",
      trim: true,
    },
    question: {
      type: String,
      default: "",
      trim: true,
    },
    questionTitle: {
      type: String,
      default: null,
      trim: true,
    },
    questionPrompt: {
      type: String,
      default: null,
      trim: true,
    },
    questionAssetPaths: {
      type: [String],
      default: [],
      select: false,
    },
    questionBankMatched: {
      type: Boolean,
      default: false,
    },
    learnerResponse: {
      type: String,
      default: "",
    },
    learnerResponseRaw: {
      type: String,
      default: "",
    },
    learnerResponseText: {
      type: String,
      default: null,
      trim: true,
    },
    correctResponses: {
      type: [String],
      default: [],
      select: false,
    },
    correctResponsesRaw: {
      type: [String],
      default: [],
      select: false,
    },
    correctResponseTexts: {
      type: [String],
      default: [],
      select: false,
    },
    result: {
      type: String,
      default: "",
      trim: true,
    },
    isCorrect: {
      type: Boolean,
      default: null,
    },
    score: {
      type: Number,
      default: null,
    },
    latency: {
      type: String,
      default: "",
      trim: true,
    },
    time: {
      type: String,
      default: "",
      trim: true,
    },
    attemptTimestamp: {
      type: String,
      default: "",
      trim: true,
    },
    maxMarks: {
      type: Number,
      default: null,
      min: 0,
    },
    source: {
      type: String,
      enum: ["cmi.interactions", "suspend_data"],
      default: "cmi.interactions",
    },
    rawData: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
    },
    review: {
      type: ScormInteractionReviewSchema,
      default: () => ({
        status: "pending",
        marks: null,
        reviewedBy: null,
        reviewedAt: null,
      }),
    },
  },
  { _id: true }
);

const ScormTrackingSchema = new Schema<IScormTracking>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    moduleId: {
      type: String,
      required: true,
      trim: true,
    },
    sectionId: {
      type: String,
      required: true,
      trim: true,
    },
    scormVersion: {
      type: String,
      enum: ["1.2", "2004"],
      default: "1.2",
    },
    lessonStatus: {
      type: String,
      enum: ["not_attempted", "incomplete", "completed", "passed", "failed", "browsed"],
      default: "not_attempted",
    },
    completionStatus: {
      type: String,
      default: "",
      trim: true,
    },
    successStatus: {
      type: String,
      default: "",
      trim: true,
    },
    progressMeasure: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    score: {
      type: Number,
      default: null,
    },
    scoreRaw: {
      type: Number,
      default: null,
    },
    scoreScaled: {
      type: Number,
      default: null,
      min: -1,
      max: 1,
    },
    scoreMin: {
      type: Number,
      default: null,
    },
    scoreMax: {
      type: Number,
      default: null,
    },
    lessonLocation: {
      type: String,
      default: "",
    },
    suspendData: {
      type: String,
      default: "",
    },
    decoded_suspend_data: {
      type: Schema.Types.Mixed,
      default: null,
    },
    sessionTime: {
      type: String,
      default: "00:00:00",
    },
    totalTime: {
      type: String,
      default: "00:00:00",
    },
    attempts: {
      type: Number,
      default: 1,
      min: 1,
    },
    lastAccessed: {
      type: Date,
      default: Date.now,
    },
    interactions: {
      type: [ScormTrackingInteractionSchema],
      default: [],
    },
  },
  { timestamps: true }
);

ScormTrackingSchema.index({ userId: 1, courseId: 1, moduleId: 1, sectionId: 1 }, { unique: true });
ScormTrackingSchema.index({ userId: 1, courseId: 1, updatedAt: -1 });

export default mongoose.model<IScormTracking>("ScormTracking", ScormTrackingSchema);
