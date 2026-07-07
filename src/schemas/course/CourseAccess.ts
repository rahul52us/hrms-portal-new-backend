import mongoose, { Document, Schema } from "mongoose";

export type CourseAccessLevel = "company" | "department" | "user";

export interface ICourseAccess extends Document {
  courseId: mongoose.Types.ObjectId;
  companyId?: mongoose.Types.ObjectId | null;
  departmentId?: mongoose.Types.ObjectId | null;
  userId?: mongoose.Types.ObjectId | null;
  accessLevel: CourseAccessLevel;
  allowFurtherAssignment: boolean;
  assessmentCriteria?: {
    totalMarks: number | null;
    passingMarks: number | null;
  } | null;
  validFrom: Date;
  validTill?: Date | null;
  assignedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CourseAccessSchema = new Schema<ICourseAccess>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    departmentId: {
      type: Schema.Types.ObjectId,
      ref: "Department",
      default: null,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    accessLevel: {
      type: String,
      enum: ["company", "department", "user"],
      required: true,
      index: true,
    },
    allowFurtherAssignment: {
      type: Boolean,
      default: false,
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
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

CourseAccessSchema.index(
  { courseId: 1, companyId: 1, accessLevel: 1 },
  {
    unique: true,
    partialFilterExpression: {
      accessLevel: "company",
      companyId: { $type: "objectId" },
    },
  }
);

CourseAccessSchema.index(
  { courseId: 1, departmentId: 1, accessLevel: 1 },
  {
    unique: true,
    partialFilterExpression: {
      accessLevel: "department",
      departmentId: { $type: "objectId" },
    },
  }
);

CourseAccessSchema.index(
  { courseId: 1, userId: 1, accessLevel: 1 },
  {
    unique: true,
    partialFilterExpression: {
      accessLevel: "user",
      userId: { $type: "objectId" },
    },
  }
);

export default mongoose.model<ICourseAccess>("CourseAccess", CourseAccessSchema);
