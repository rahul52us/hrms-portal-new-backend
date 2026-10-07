import mongoose, { Document, Schema } from "mongoose";

export const EMPLOYEE_STATUTORY_ASSIGNMENT_STATUSES = ["assigned", "cancelled"] as const;

export interface EmployeeStatutoryAssignmentI extends Document {
  company: mongoose.Types.ObjectId;
  employee: mongoose.Types.ObjectId;
  employeeNameSnapshot: string;
  employeeCodeSnapshot: string;
  statutoryProfile: mongoose.Types.ObjectId;
  statutoryProfileVersion: mongoose.Types.ObjectId;
  statutoryProfileVersionNumber: number;
  countryCode: string;
  providerKey: string;
  providerImplementationVersion: string;
  enabledModulesSnapshot: string[];
  effectiveFrom: Date;
  status: (typeof EMPLOYEE_STATUTORY_ASSIGNMENT_STATUSES)[number];
  identifiers: Record<string, string>;
  applicability: Record<string, boolean>;
  assignmentReason: string;
  createdBy: mongoose.Types.ObjectId;
  cancelledAt?: Date | null;
  cancelledBy?: mongoose.Types.ObjectId | null;
  cancellationReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const EmployeeStatutoryAssignmentSchema = new Schema<EmployeeStatutoryAssignmentI>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true, immutable: true },
    employee: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true, immutable: true },
    employeeNameSnapshot: { type: String, required: true, trim: true, immutable: true },
    employeeCodeSnapshot: { type: String, required: true, trim: true, immutable: true },
    statutoryProfile: { type: Schema.Types.ObjectId, ref: "StatutoryProfile", required: true, index: true, immutable: true },
    statutoryProfileVersion: { type: Schema.Types.ObjectId, ref: "StatutoryProfileVersion", required: true, index: true, immutable: true },
    statutoryProfileVersionNumber: { type: Number, required: true, min: 1, immutable: true },
    countryCode: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{2}$/, immutable: true },
    providerKey: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    providerImplementationVersion: { type: String, required: true, trim: true, immutable: true },
    enabledModulesSnapshot: { type: [{ type: String, trim: true }], required: true, default: [], immutable: true },
    effectiveFrom: { type: Date, required: true, index: true, immutable: true },
    status: { type: String, enum: EMPLOYEE_STATUTORY_ASSIGNMENT_STATUSES, required: true, default: "assigned", index: true },
    identifiers: { type: Schema.Types.Mixed, required: true, default: {}, immutable: true },
    applicability: { type: Schema.Types.Mixed, required: true, default: {}, immutable: true },
    assignmentReason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

EmployeeStatutoryAssignmentSchema.index(
  { company: 1, employee: 1, effectiveFrom: 1 },
  { unique: true, partialFilterExpression: { status: "assigned" } }
);
EmployeeStatutoryAssignmentSchema.index({ company: 1, employee: 1, status: 1, effectiveFrom: -1 });
EmployeeStatutoryAssignmentSchema.index({ company: 1, providerKey: 1, status: 1, effectiveFrom: -1 });

const EmployeeStatutoryAssignment =
  (mongoose.models.EmployeeStatutoryAssignment as mongoose.Model<EmployeeStatutoryAssignmentI>) ||
  mongoose.model<EmployeeStatutoryAssignmentI>(
    "EmployeeStatutoryAssignment",
    EmployeeStatutoryAssignmentSchema
  );

export default EmployeeStatutoryAssignment;
