import mongoose, { Document, Schema } from "mongoose";

interface AssigneeI {
  user: mongoose.Schema.Types.ObjectId;
  isActive: boolean;
}

interface SubtaskI extends Document {
  title: string;
  description?: mongoose.Schema.Types.Mixed;
  status: string;
  createdBy: mongoose.Schema.Types.ObjectId;
  duedate?: Date;
  startDate?: Date;
  endDate?: Date;
  assignee?: AssigneeI[];
  createdAt: Date;
  updatedAt: Date;
}

interface CommentI extends Document {
  user: mongoose.Schema.Types.ObjectId;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

interface ActivityLogI extends Document {
  user: mongoose.Schema.Types.ObjectId;
  action: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

interface TaskI extends Document {
  projectId: mongoose.Schema.Types.ObjectId;
  title: string;
  isActive: boolean;
  createdBy?: mongoose.Schema.Types.ObjectId;
  description?: mongoose.Schema.Types.Mixed;
  team_members?: AssigneeI[];
  assigner?: mongoose.Schema.Types.ObjectId[];
  company: mongoose.Schema.Types.ObjectId;
  status: string;
  priority?: string;
  duedate?: Date;
  startDate?: Date;
  endDate?: Date;
  subtasks?: SubtaskI[];
  comments?: CommentI[];
  activityLog?: ActivityLogI[];
  labels?: string[];
  dependencies?: mongoose.Schema.Types.ObjectId[];
  reminders?: Date[];
  attach_files?: {
    project?: mongoose.Schema.Types.ObjectId;
    title?: string;
    description?: mongoose.Schema.Types.Mixed;
    file: {
      name: string;
      url: string;
      type: string;
    };
  }[];
  approval?: string;
  progress?: number;
  customFields?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

// Schema for Assignee
const UserSchema = new Schema<AssigneeI>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

// Schema for Subtask
const SubtaskSchema = new Schema<SubtaskI>({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  description: {
    type: mongoose.Schema.Types.Mixed,
    trim: true,
  },
  status: {
    type: String,
    enum: ["backlog", "toDo", "inProgress", "done"],
    default: "backlog",
  },
  duedate: {
    type: Date,
  },
  startDate: {
    type: Date,
  },
  endDate: {
    type: Date,
  },
  assignee: {
    type: [UserSchema],
    default: [],
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
});

// Schema for Comment
const CommentSchema = new Schema<CommentI>({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  comment: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
  deletedAt: {
    type: Date,
  },
});

// Schema for Activity Log
const ActivityLogSchema = new Schema<ActivityLogI>({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  action: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
  deletedAt: {
    type: Date,
  },
});

// Main Task Schema
const TaskSchema = new Schema<TaskI>({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: mongoose.Schema.Types.Mixed,
    trim: true,
  },
  team_members: {
    type: [UserSchema],
    default: [],
  },
  reminders: [Date],
  status: {
    type: String,
    enum: ["backlog", "toDo", "inProgress", "done", "complete"],
    default: "backlog",
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high"],
    default: "medium",
  },
  duedate: {
    type: Date,
  },
  startDate: {
    type: Date,
  },
  endDate: {
    type: Date,
  },
  subtasks: [SubtaskSchema],
  comments: [CommentSchema],
  activityLog: [ActivityLogSchema],
  dependencies: {
    type: [UserSchema],
    default: [],
  },
  assigner: {
    type: [UserSchema],
    default: [],
  },
  approval: {
    type: String,
    enum: ["satisfactory", "unsatisfactory"],
  },
  attach_files: [
    {
      project: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Project",
      },
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
  progress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  customFields: {
    type: Map,
    of: Schema.Types.Mixed,
  },
  createdAt: {
    type: Date,
    default: new Date(),
  },
  updatedAt: {
    type: Date,
  },
  deletedAt: {
    type: Date,
  },
});

TaskSchema.index({ projectId: 1, title: 1 });

export default mongoose.model<TaskI>("Task", TaskSchema);
