import mongoose, { Document, Schema } from 'mongoose';

export interface ICourseSectionContent {
  name: string;
  kind: string;
  mimeType: string;
  extension: string;
  sizeInBytes: number;
  previewUrl?: string;
  slideCount?: number | null;
  scormMetadata?: {
    totalSlides?: number | null;
    sourceAssetPath?: string | null;
    // Legacy courses may still contain upload-time question metadata.
    questions?: any[];
  };
}

export interface IStudyMaterial {
  name: string;
  kind: string;
  mimeType: string;
  extension: string;
  sizeInBytes: number;
  previewUrl?: string;
}

export interface ICourseSection {
  order: number;
  title: string;
  description: string;
  content?: ICourseSectionContent | null;
  studyMaterial?: IStudyMaterial[] | null;
}

export interface ICourseModule {
  order: number;
  title: string;
  summary: string;
  sectionCount: number;
  sections: ICourseSection[];
  studyMaterial?: IStudyMaterial[] | null;
  assessments: {
    quizEnabled: boolean;
    testEnabled: boolean;
    quiz?: ICourseQuiz | null;
  };
}

export interface ICourseQuizOption {
  optionId: string;
  label: string;
  text: string;
  isCorrect: boolean;
}

export interface ICourseQuizQuestion {
  questionId: string;
  sn: number;
  question: string;
  options: ICourseQuizOption[];
  correctOptionId: string;
  correctOptionLabel: string;
  marks: number;
  explanation?: string;
}

export interface ICourseQuiz {
  quizId: string;
  title: string;
  scope: "module" | "final";
  moduleId?: string;
  source: "manual" | "excel" | "mixed";
  questionCount: number;
  totalMarks: number;
  questions: ICourseQuizQuestion[];
  updatedAt?: Date;
}

export interface ICourse extends Document {
  courseCode: string;
  title: string;
  slug: string;
  description: { text: string; html: string };
  highlights: {
    learningOutcomes: string[];
  };
  instructor: {
    name: string;
    designation: string;
  };
  taxonomy: { languages: string[]; categories: string[]; level: string };
  visibility: {
    type: "private" | "public";
  };
  assessment: {
    totalMarks: number | null;
    passingMarks: number | null;
  };
  metrics: {
    averageRating: number | null;
    popularityScore: number;
    totalEnrollments: number;
  };
  thumbnailUrl?: string;
  scormFilePath?: string;
  company?: mongoose.Types.ObjectId;
  createdBy?: mongoose.Types.ObjectId;
  curriculum: {
    quizStrategy: string;
    totalModules: number;
    totalSections: number;
    finalQuiz?: ICourseQuiz | null;
    modules: ICourseModule[];
  };
  progression: {
    completionWindowDays: number | null;
    dripEnabled: boolean;
    certificateEnabled: boolean;
    certificateTemplateId?: mongoose.Types.ObjectId | null;
    mandatoryModules: boolean;
  };
  commerce: {
    pricingModel: string;
    currency: string;
    amountInRupees: number | null;
    accessDurationDays: number | null;
    companyAccess: string[];
  };
  enrollment: {
    learnerSelection: {
      totalSelected: number;
      selectedLearners: string[];
    };
  };
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const CourseSectionSchema = new Schema({
  order: Number,
  title: String,
  description: String,
  content: {
    type: Schema.Types.Mixed,
    default: null,
  },
  studyMaterial: {
    type: [Schema.Types.Mixed],
    default: null,
  },
}, { _id: false });

const CourseQuizOptionSchema = new Schema({
  optionId: { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },
  text: { type: String, required: true, trim: true },
  isCorrect: { type: Boolean, default: false },
}, { _id: false });

const CourseQuizQuestionSchema = new Schema({
  questionId: { type: String, required: true, trim: true },
  sn: { type: Number, default: 0 },
  question: { type: String, required: true, trim: true },
  options: { type: [CourseQuizOptionSchema], default: [] },
  correctOptionId: { type: String, required: true, trim: true },
  correctOptionLabel: { type: String, required: true, trim: true },
  marks: { type: Number, default: 1, min: 0 },
  explanation: { type: String, default: '', trim: true },
}, { _id: false });

const CourseQuizSchema = new Schema({
  quizId: { type: String, required: true, trim: true },
  title: { type: String, default: '', trim: true },
  scope: { type: String, enum: ["module", "final"], required: true },
  moduleId: { type: String, default: '', trim: true },
  source: { type: String, enum: ["manual", "excel", "mixed"], default: "manual" },
  questionCount: { type: Number, default: 0 },
  totalMarks: { type: Number, default: 0 },
  questions: { type: [CourseQuizQuestionSchema], default: [] },
  updatedAt: { type: Date, default: Date.now },
}, { _id: false });

const CourseModuleSchema = new Schema({
  order: Number,
  title: String,
  summary: String,
  sectionCount: Number,
  sections: [CourseSectionSchema],
  studyMaterial: {
    type: Schema.Types.Mixed,
    default: null,
  },
  assessments: {
    quizEnabled: { type: Boolean, default: false },
    testEnabled: { type: Boolean, default: false },
    quiz: {
      type: CourseQuizSchema,
      default: null,
    },
  },
}, { _id: false });

const CourseSchema: Schema = new Schema(
  {
    title: { type: String, required: true },
    courseCode: { type: String, required: true, unique: true, index: true, trim: true },
    slug: { type: String },
    description: {
      text: { type: String, default: '' },
      html: { type: String, default: '' },
    },
    highlights: {
      learningOutcomes: {
        type: [{ type: String, trim: true }],
        default: [],
      },
    },
    instructor: {
      name: { type: String, default: '', trim: true },
      designation: { type: String, default: '', trim: true },
    },
    taxonomy: {
      languages: [{ type: String }],
      categories: [{ type: String }],
      level: { type: String, default: 'Beginner' },
    },
    visibility: {
      type: {
        type: String,
        enum: ["private", "public"],
        default: "private",
      },
    },
    assessment: {
      totalMarks: { type: Number, default: null },
      passingMarks: { type: Number, default: null },
    },
    metrics: {
      averageRating: { type: Number, default: null },
      popularityScore: { type: Number, default: 0 },
      totalEnrollments: { type: Number, default: 0 },
    },
    thumbnailUrl: { type: String },
    scormFilePath: { type: String },
    company: { type: Schema.Types.ObjectId, ref: 'Company', index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    curriculum: {
      quizStrategy: { type: String, default: 'per-module' },
      totalModules: { type: Number, default: 0 },
      totalSections: { type: Number, default: 0 },
      finalQuiz: {
        type: CourseQuizSchema,
        default: null,
      },
      modules: [CourseModuleSchema],
    },
    progression: {
      completionWindowDays: { type: Number, default: null },
      dripEnabled: { type: Boolean, default: false },
      certificateEnabled: { type: Boolean, default: true },
      certificateTemplateId: { type: Schema.Types.ObjectId, ref: "CertificateTemplate", default: null },
      mandatoryModules: { type: Boolean, default: true },
    },
    commerce: {
      pricingModel: { type: String, default: 'free' },
      currency: { type: String, default: 'INR' },
      amountInRupees: { type: Number, default: null },
      accessDurationDays: { type: Number, default: null },
      companyAccess: [{ type: String }],
    },
    enrollment: {
      learnerSelection: {
        totalSelected: { type: Number, default: 0 },
        selectedLearners: [{ type: String }],
      },
    },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  },
  { timestamps: true }
);

CourseSchema.index({ createdBy: 1, createdAt: -1 });
CourseSchema.index({ company: 1, createdBy: 1, createdAt: -1 });
CourseSchema.index({ status: 1, "visibility.type": 1, createdAt: -1 });
CourseSchema.index({ courseCode: 1 }, { unique: true });

export default mongoose.model<ICourse>('Course', CourseSchema);
