import mongoose, { Document, Schema } from 'mongoose';

interface BlogComment extends Document {
  user: mongoose.Types.ObjectId;
  content: string;
  blog?: mongoose.Types.ObjectId;
  parentComment?: mongoose.Types.ObjectId;
  company?: mongoose.Types.ObjectId;
  replies: mongoose.Types.ObjectId[];
  createdAt:Date,
  updatedAt:Date
}

const blogCommentSchema = new Schema<BlogComment>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    blog:{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Blog',
      required: true,
    },
    company:{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    content: {
      type: String,
      trim:true,
      required: true,
    },
    parentComment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BlogComment',
      default: null
    },
    replies: [
      {
        type: mongoose.Types.ObjectId,
        ref: 'BlogComment',
      },
    ],
    createdAt:{
      type : Date,
      default : new Date()
    },
    updatedAt:{
      type : Date
    }
  },
);

const BlogCommentModel = mongoose.model<BlogComment>('BlogComment', blogCommentSchema);

export default BlogCommentModel;
