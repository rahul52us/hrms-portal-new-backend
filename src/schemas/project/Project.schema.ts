import mongoose, { Document, Schema } from "mongoose";

interface ProjectI extends Document {
  project_name: string;
  subtitle?: string;
  description?: string;
  logo?: string;
  is_active?: boolean;
  createdBy: mongoose.Schema.Types.ObjectId;
  dueDate?: Date;
  company: mongoose.Schema.Types.ObjectId;
  priority?: string;
  project_manager?: any;
  startDate?: Date;
  endDate?: Date;
  status?: string;
  customers?: mongoose.Schema.Types.ObjectId[];
  followers?: mongoose.Schema.Types.ObjectId[];
  team_members?: mongoose.Schema.Types.ObjectId[];
  approval?: string;
  attach_files?: any;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
  tags:any
}

const UserSchema = new Schema<any>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const ProjectSchema = new mongoose.Schema<ProjectI>({
  project_name: {
    type: String,
    required: true,
    trim: true,
  },
  subtitle: {
    type: String,
    trim: true,
  },
  description: {
    type: mongoose.Schema.Types.Mixed,
    trim: true,
  },
  logo: {
    name: {
      type: String,
    },
    url: {
      type: String,
    },
    type: {
      type: String,
    },
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high"],
    default: "medium",
  },
  is_active: {
    type: Boolean,
    default: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "User",
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "Company",
  },
  project_manager: {
    type: [UserSchema],
    default: []
  },
  status: {
    type: String,
    enum: ["backlog", "toDo", "inProgress", "done", "complete"],
    default: "backlog",
  },
  startDate: {
    type: Date
  },
  endDate: {
    type: Date,
  },
  dueDate: {
    type: Date,
  },
  tags : {
    type : Array,
    default : []
  },
  customers: {
    type: [UserSchema],
    default: []
  },
  team_members: {
    type: [UserSchema],
    default: []
  },
  followers: {
    type: [UserSchema],
    default: []
  },
  approval: {
    type: String,
    enum: ["satisfactory", "unSatisfactory"],
  },
  attach_files: [
    {
      title: {
        type: String,
        trim: true,
      },
      description: {
        type: mongoose.Schema.Types.Mixed,
        trim: true,
      },
      file: {
        name: {
          type: String,
        },
        url: {
          type: String,
        },
        type: {
          type: String,
        },
      },
    },
  ],
  deletedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
});

export default mongoose.model<ProjectI>("Project", ProjectSchema);
