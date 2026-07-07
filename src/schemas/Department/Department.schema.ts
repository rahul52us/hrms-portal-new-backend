import mongoose, { Schema, Document } from "mongoose";

export interface DepartmentI extends Document {
  company: mongoose.Schema.Types.ObjectId;
  departmentName: string;
  code: string;
  deletedAt?: Date;
  createdAt?: Date;
}

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
