import mongoose, { Schema, Document } from "mongoose";

export interface IEmailToken extends Document {
  userId?: mongoose.Types.ObjectId;
  company?: mongoose.Types.ObjectId;
  metaData?: mongoose.Schema.Types.Mixed;
  token: string;
  type: string;
  is_active?: boolean;
  isActive?: boolean;
  expiresAt?: Date;
  createdAt: Date;
  deletedAt?: Date
}

const Token: Schema<IEmailToken> = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  company : {
    type : Schema.Types.ObjectId,
    ref : 'Company'
  },
  type: {
    type: String,
    required: true,
  },
  token: {
    type: String,
    required: true,
  },
  is_active:{
    type : Boolean,
    default : false
  },
  isActive: {
    type: Boolean,
    default: false,
    index: true,
  },
  expiresAt: {
    type: Date,
  },
  metaData : {
    type : mongoose.Schema.Types.Mixed
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  deletedAt : {
    type : Date
  }
});

Token.index({ token: 1 });
Token.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } });
Token.index({ type: 1, isActive: 1, expiresAt: 1 });

export default mongoose.model<IEmailToken>(
  "Token",
  Token
);
