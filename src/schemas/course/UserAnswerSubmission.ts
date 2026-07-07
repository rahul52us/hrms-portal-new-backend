import mongoose, { Document, Schema } from "mongoose";

export type AnswerReviewStatus = "pending" | "reviewed";

export interface IUserAnswerSubmission extends Document {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  moduleId: string;
  sectionId: string;
  questionId: string;
  answer: string;
  correctAnswer?: string;
  isCorrect?: boolean | null;
  marksAwarded?: number | null;
  maxMarks?: number | null;
  feedback?: string;
  status: AnswerReviewStatus;
  reviewedBy?: mongoose.Types.ObjectId | null;
  reviewedAt?: Date | null;
  rawData?: any;
  createdAt: Date;
  updatedAt: Date;
}

const UserAnswerSubmissionSchema = new Schema<IUserAnswerSubmission>(
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
    questionId: {
      type: String,
      required: true,
      trim: true,
    },
    answer: {
      type: String,
      default: "",
    },
    correctAnswer: {
      type: String,
      default: "",
    },
    isCorrect: {
      type: Boolean,
      default: null,
    },
    marksAwarded: {
      type: Number,
      default: null,
      min: 0,
    },
    maxMarks: {
      type: Number,
      default: null,
      min: 0,
    },
    feedback: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "reviewed"],
      default: "pending",
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
    rawData: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

UserAnswerSubmissionSchema.index(
  { userId: 1, courseId: 1, moduleId: 1, sectionId: 1, questionId: 1 },
  { unique: true }
);
UserAnswerSubmissionSchema.index({ userId: 1, courseId: 1, status: 1, updatedAt: -1 });

export default mongoose.model<IUserAnswerSubmission>("UserAnswerSubmission", UserAnswerSubmissionSchema);
