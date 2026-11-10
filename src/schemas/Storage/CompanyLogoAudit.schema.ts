import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  company: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actor: { type: Schema.Types.ObjectId, required: true, immutable: true },
  action: { type: String, enum: ["created", "replaced", "removed"], required: true, immutable: true },
  before: { type: Schema.Types.Mixed, default: null, immutable: true },
  after: { type: Schema.Types.Mixed, default: null, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ company: 1, createdAt: -1 });
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  schema.pre(operation as any, function(next) { next(new Error("Company logo audit is append-only")); });
}
export default mongoose.models.CompanyLogoAudit || mongoose.model("CompanyLogoAudit", schema);
