import mongoose, { Schema, Document } from "mongoose";

export interface DepartmentI extends Document {
  company: mongoose.Schema.Types.ObjectId;
  departmentName: string;
  code: string;
  departmentHead?: mongoose.Schema.Types.ObjectId;
  teams?: {
    _id?: mongoose.Types.ObjectId;
    name: string;
    code?: string;
    description?: string;
    isActive?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  }[];
  deletedAt?: Date;
  createdAt?: Date;
}

const DepartmentTeamSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  { _id: true }
);

const DepartmentSchema: Schema<DepartmentI> = new Schema<DepartmentI>({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required: true,
  },

  departmentName: {
    type: String,
    required: true,
  },
  code: {
    type: String,
    required: true,
  },
  departmentHead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  teams: {
    type: [DepartmentTeamSchema],
    default: [],
  },
  deletedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
});

const Department = mongoose.model<DepartmentI>("Department", DepartmentSchema);

export default Department;
