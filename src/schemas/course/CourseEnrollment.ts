import mongoose, { Document, Schema } from "mongoose";

export type CourseEnrollmentStatus = "not_started" | "in_progress" | "completed";
export type CourseEnrollmentSourceType = "direct" | "batch" | "self";

export interface ICourseEnrollmentSource {
  type: CourseEnrollmentSourceType;
  batchId?: mongoose.Types.ObjectId | null;
  batchName?: string | null;
  assignedBy: mongoose.Types.ObjectId;
  assessmentCriteria?: {
    totalMarks: number | null;
    passingMarks: number | null;
  } | null;
  validFrom?: Date | null;
  validTill?: Date | null;
  dueDate?: Date | null;
  assignedAt: Date;
}

export interface ICourseEnrollment extends Document {
  courseId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  assignedBy: mongoose.Types.ObjectId;
  status: CourseEnrollmentStatus;
  progressPercent?: number | null;
  assessmentCriteria?: {
    totalMarks: number | null;
    passingMarks: number | null;
  } | null;
  validFrom: Date;
  validTill?: Date | null;
  dueDate?: Date | null;
  sources: ICourseEnrollmentSource[];
  createdAt: Date;
  updatedAt: Date;
}

const CourseEnrollmentSourceSchema = new Schema<ICourseEnrollmentSource>(
  {
    type: {
      type: String,
      enum: ["direct", "batch", "self"],
      required: true,
    },
    batchId: {
      type: Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    batchName: {
      type: String,
      default: null,
      trim: true,
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assessmentCriteria: {
      totalMarks: { type: Number, default: null },
      passingMarks: { type: Number, default: null },
    },
    validFrom: {
      type: Date,
      default: Date.now,
    },
    validTill: {
      type: Date,
      default: null,
    },
    dueDate: {
      type: Date,
      default: null,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const CourseEnrollmentSchema = new Schema<ICourseEnrollment>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["not_started", "in_progress", "completed"],
      default: "not_started",
    },
    progressPercent: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    assessmentCriteria: {
      totalMarks: { type: Number, default: null },
      passingMarks: { type: Number, default: null },
    },
    validFrom: {
      type: Date,
      default: Date.now,
      index: true,
    },
    validTill: {
      type: Date,
      default: null,
      index: true,
    },
    dueDate: {
      type: Date,
      default: null,
    },
    sources: {
      type: [CourseEnrollmentSourceSchema],
      default: [],
    },
  },
  { timestamps: true }
);

CourseEnrollmentSchema.index({ courseId: 1, userId: 1 }, { unique: true });
CourseEnrollmentSchema.index({ userId: 1, status: 1, createdAt: -1 });

export default mongoose.model<ICourseEnrollment>("CourseEnrollment", CourseEnrollmentSchema);
