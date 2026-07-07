import mongoose, { Schema, Document } from "mongoose";

interface WebsiteTemplateI extends Document {
  user: mongoose.Schema.Types.ObjectId;
  company: mongoose.Schema.Types.ObjectId;
  webType?: string;
  status?:string;
  deletedAt?: Date;
  is_active: boolean;
  name: string;
  sectionsLayout: any;
  webInfo: mongoose.Schema.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const WebsiteTemplate = new Schema<WebsiteTemplateI>({
  name: { type: String, required: true, index  : true },
  webType: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "Company",
  },
  status : {type : String, default : 'inProgress'},
  is_active: { type: Boolean, default: true },
  sectionsLayout: { type: mongoose.Schema.Types.Mixed, default: [] },
  webInfo: { type: mongoose.Schema.Types.Mixed, default: {} },
  deletedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

export default mongoose.model<WebsiteTemplateI>(
  "WebsiteTemplate",
  WebsiteTemplate
);