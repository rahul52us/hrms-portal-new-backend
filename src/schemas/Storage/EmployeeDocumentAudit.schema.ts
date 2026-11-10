import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  employee: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true },
  requestHash: { type: String, required: true, immutable: true },
  before: { type: Schema.Types.Mixed, immutable: true },
  after: { type: Schema.Types.Mixed, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, actor: 1, requestId: 1 }, { unique: true });
schema.index({ company: 1, employee: 1, createdAt: -1 });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation as any, function(next) { next(new Error("Employee document audit is append-only")); });
}
export default mongoose.models.EmployeeDocumentAudit || mongoose.model("EmployeeDocumentAudit", schema);
