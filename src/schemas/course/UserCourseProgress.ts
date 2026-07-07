import mongoose, { Document, Schema } from "mongoose";

export type ScormLessonStatus =
  | "not_attempted"
  | "incomplete"
  | "completed"
  | "passed"
  | "failed"
  | "browsed";

export interface IUserCourseProgress extends Document {
  userId: mongoose.Types.ObjectId;
  courseId: mongoose.Types.ObjectId;
  lessonStatus: ScormLessonStatus;
  completionStatus?: string;
  successStatus?: string;
  progressMeasure?: number | null;
  progress: number;
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
  createdAt: Date;
  updatedAt: Date;
}

const UserCourseProgressSchema = new Schema<IUserCourseProgress>(
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
  },
  { timestamps: true }
);

UserCourseProgressSchema.index({ userId: 1, courseId: 1 }, { unique: true });
UserCourseProgressSchema.index({ userId: 1, lastAccessed: -1 });

export default mongoose.model<IUserCourseProgress>("UserCourseProgress", UserCourseProgressSchema);
