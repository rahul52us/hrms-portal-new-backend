import mongoose, { Document, Schema } from "mongoose";

interface Reaction {
  user: mongoose.Schema.Types.ObjectId;
  type: string;
}

interface Blog extends Document {
  title: string;
  coverImage: any;
  subTitle:string;
  slug:string;
  category:string;
  target?:string;
  content: string;
  isPrivate: boolean;
  isActive:boolean;
  createdBy: mongoose.Types.ObjectId;
  company: mongoose.Types.ObjectId;
  tags: string[];
  reactions: Reaction[];
  status:string;
  comments: mongoose.Types.ObjectId[];
  createdAt:Date,
  updatedAt:Date
}

const blogSchema = new Schema<Blog>(
  {
    title: {
      type: String,
      required: true,
      index:true
    },
    target : {
      type : String
    },
    subTitle : {
      type : String,
      required : true
    },
    slug : {
      type : String
    },
    category : {
      type : String
    },
    coverImage: {
      name: {
        type: String,
      },
      url: {
        type: String,
      },
      type: {
        type: String
      },
    },
    content: {
      type: String,
      required: true,
    },
    isPrivate : {
      type : Boolean,
      default : false
    },
    tags: [String],
    status:{
      type : String,
      enum : ['draft','published'],
      default : 'draft'
    },
    reactions: [
      {
        user: {
          type: mongoose.Types.ObjectId,
          ref: "User",
          required: true
        },
        type: {
          type: String,
          required: true,
        },
      },
    ],
    comments: [
      {
        type: mongoose.Types.ObjectId,
        ref: "BlogComment"
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true
    },
    isActive : {
      type : Boolean,
      default : true
    },
    createdAt:{
      type : Date,
      default : new Date()
    },
    updatedAt:{
      type : Date
    }
  }
);

const BlogModel = mongoose.model<Blog>("Blog", blogSchema);

export default BlogModel;
