import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { v2 as cloudinary } from 'cloudinary';
import Course from '../../schemas/course/Course';
import CourseAccess from '../../schemas/course/CourseAccess';
import CourseEnrollment from '../../schemas/course/CourseEnrollment';
import Company from '../../schemas/company/Company';
import {
  ChunkedAssetUpload,
  deleteCourseScormAssets,
  deleteScormAssetsByPaths,
  deleteScormUploadChunks,
  extractAndStoreChunkedScormPackage,
  extractAndStoreScormPackage,
  getScormAssetSlideMetadata,
  storeCourseAssetFile,
  storeChunkedCourseAssetFile,
  storeScormUploadChunk,
} from '../../services/scorm/scormStorage.service';
import authenticate from '../../modules/config/authenticate';
import {
  PERMISSION_KEYS,
  ensureCourseViewPermission,
  ensurePermission,
} from '../../services/permissions/permission.utils';
import {
  deriveCourseType,
  normalizeCourseHighlights,
  normalizeCourseAssessment,
  normalizeCourseInstructorForStorage,
  normalizeCourseVisibilityType,
  serializeCoursePresentation,
} from '../../services/course/courseMetadata.helpers';
import {
  getLearnerCourseQuizzesService,
  normalizeCourseQuizConfiguration,
  previewCourseQuizExcelService,
  sanitizeCourseCurriculumForLearner,
  submitLearnerCourseQuizService,
} from '../../services/course/courseQuiz.service';
import { processScormQuestionBank } from '../../services/scorm/scormQuestionBank.service';
import { deriveModuleId, deriveSectionId } from '../../services/scorm/scormTracking.helpers';
import { ensureCompanyManagementAccess } from '../../services/company/utils/activityGuards';
import { getVisibleCourseScopeForUser } from '../../services/course/courseScope.helpers';
import { syncCourseMembershipsForExistingEnrollments } from '../../services/company/courseMembership.service';

const router = express.Router();
const SCORM_QUESTION_BANK_EXTRACTION_ENABLED =
  String(process.env.SCORM_QUESTION_BANK_EXTRACTION_ENABLED || '').toLowerCase() === 'true';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadDir = path.join(os.tmpdir(), 'hrms-backend', 'uploads', 'temp');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`),
  }),
});

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024,
  },
});

const quizExcelUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

const coursePresentationPopulate = [
  { path: 'company', select: 'company_name' },
  {
    path: 'createdBy',
    select: 'name designation company pic',
    populate: {
      path: 'company',
      select: 'company_name',
    },
  },
];

function normalizeCourseStatus(action: unknown) {
  if (action === 'publish' || action === 'published') {
    return 'published';
  }

  return 'draft';
}

function cleanupUploadedTempFile(file?: Express.Multer.File) {
  if (file?.path && fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }
}

async function generateUniqueCourseCode(preferredCode?: string) {
  const requestedCode = String(preferredCode || "").trim().toUpperCase();
  if (requestedCode) {
    const existingCourse = await Course.findOne({ courseCode: requestedCode }).select("_id").lean();
    if (!existingCourse) {
      return requestedCode;
    }
  }

  while (true) {
    const randomToken = Math.random().toString(36).slice(2, 8).toUpperCase();
    const courseCode = `CRS-${randomToken}`;
    const existingCourse = await Course.findOne({ courseCode }).select("_id").lean();
    if (!existingCourse) {
      return courseCode;
    }
  }
}

function hasPreviewUrl(asset: any) {
  return Boolean(String(asset?.previewUrl || '').trim());
}

function collectCourseAssetPathsFromCurriculum(curriculum: any) {
  const assetPaths = new Set<string>();

  for (const moduleItem of curriculum?.modules || []) {
    for (const material of moduleItem?.studyMaterial || []) {
      const previewUrl = String(material?.previewUrl || '').trim();
      if (previewUrl) {
        assetPaths.add(previewUrl);
      }
    }

    for (const section of moduleItem?.sections || []) {
      const contentPreviewUrl = String(section?.content?.previewUrl || '').trim();
      if (contentPreviewUrl) {
        assetPaths.add(contentPreviewUrl);
      }

      for (const material of section?.studyMaterial || []) {
        const previewUrl = String(material?.previewUrl || '').trim();
        if (previewUrl) {
          assetPaths.add(previewUrl);
        }
      }
    }
  }

  return Array.from(assetPaths);
}

function findFirstScormPathFromModules(modules: any[]) {
  for (const moduleItem of modules || []) {
    for (const section of moduleItem?.sections || []) {
      const content = section?.content;
      if (
        content &&
        (content.kind === 'scorm' || content.kind === 'zip') &&
        hasPreviewUrl(content)
      ) {
        return String(content.previewUrl).trim();
      }
    }
  }

  return '';
}

async function resolveEditableCourseCode(courseId: mongoose.Types.ObjectId, preferredCode: unknown, fallbackCode: string) {
  const requestedCode = String(preferredCode || fallbackCode || '').trim().toUpperCase();
  if (!requestedCode) {
    return fallbackCode;
  }

  const existingCourse = await Course.findOne({
    courseCode: requestedCode,
    _id: { $ne: courseId },
  }).select('_id').lean();

  if (existingCourse) {
    throw new Error('COURSE_CODE_EXISTS');
  }

  return requestedCode;
}

async function cleanupChunkUploads(uploads: ChunkedAssetUpload[], warningMessage: string) {
  for (const upload of uploads) {
    await deleteScormUploadChunks(upload.uploadId).catch((cleanupError) => {
      console.warn(warningMessage, cleanupError);
    });
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSortKey(value: unknown) {
  const normalizedValue = String(value || '').trim().toLowerCase();

  switch (normalizedValue) {
    case 'popularity':
      return 'popularity';
    case 'price_asc':
    case 'price-low-to-high':
    case 'low_to_high':
      return 'price_asc';
    case 'price_desc':
    case 'price-high-to-low':
    case 'high_to_low':
      return 'price_desc';
    case 'highest_rated':
    case 'rating':
      return 'highest_rated';
    case 'title_az':
      return 'title_az';
    case 'oldest':
      return 'oldest';
    default:
      return 'latest';
  }
}

function normalizeActorRole(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^department[-\s]?head$/i, 'departmenthead');
}

function normalizeOptionalObjectId(value: unknown) {
  const normalizedValue = String(value || '').trim();
  return mongoose.Types.ObjectId.isValid(normalizedValue)
    ? new mongoose.Types.ObjectId(normalizedValue)
    : null;
}

function toObjectIdList(ids: string[]) {
  return ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

function normalizeCatalogFilters(query: any) {
  return {
    search: String(query.search || query.q || '').trim(),
    status: String(query.status || '').trim().toLowerCase(),
    visibilityType: String(query.visibilityType || '').trim().toLowerCase(),
    pricingModel: String(query.pricingModel || query.paymentType || '').trim().toLowerCase(),
    category: String(query.category || '').trim(),
    language: String(query.language || '').trim(),
    courseType: String(query.courseType || '').trim().toLowerCase(),
    sortBy: normalizeSortKey(query.sortBy),
  };
}

function buildBaseCourseQuery(filters: ReturnType<typeof normalizeCatalogFilters>) {
  const query: any = {};

  if (filters.search) {
    query.title = { $regex: escapeRegex(filters.search), $options: 'i' };
  }

  if (filters.status) {
    query.status = filters.status;
  }

  if (filters.visibilityType === 'private' || filters.visibilityType === 'public') {
    query['visibility.type'] = filters.visibilityType;
  }

  if (filters.pricingModel === 'free' || filters.pricingModel === 'paid') {
    query['commerce.pricingModel'] = filters.pricingModel;
  }

  if (filters.category) {
    query['taxonomy.categories'] = filters.category;
  }

  if (filters.language) {
    query['taxonomy.languages'] = filters.language;
  }

  return query;
}

async function buildCourseEnrollmentCountMap(courseIds: string[]) {
  const normalizedCourseIds = courseIds
    .filter(Boolean)
    .map((courseId) => String(courseId).trim());

  if (!normalizedCourseIds.length) {
    return new Map<string, number>();
  }

  const groupedCounts = await CourseEnrollment.aggregate([
    {
      $match: {
        courseId: {
          $in: normalizedCourseIds
            .filter((courseId) => mongoose.Types.ObjectId.isValid(courseId))
            .map((courseId) => new mongoose.Types.ObjectId(courseId)),
        },
      },
    },
    {
      $group: {
        _id: '$courseId',
        totalEnrollments: { $sum: 1 },
      },
    },
  ]);

  return new Map(
    groupedCounts.map((entry: any) => [String(entry._id), Number(entry.totalEnrollments || 0)])
  );
}

function serializeCourseCatalogItem(course: any, enrollmentCount: number) {
  const presentationCourse = serializeCoursePresentation(course);
  const pricingAmount = Number(course?.commerce?.amountInRupees || 0) || 0;
  const averageRatingValue = Number(course?.metrics?.averageRating);
  const averageRating = Number.isFinite(averageRatingValue) ? averageRatingValue : null;
  const totalEnrollments = Math.max(
    0,
    Number.isFinite(Number(course?.metrics?.totalEnrollments))
      ? Number(course.metrics.totalEnrollments)
      : enrollmentCount
  );
  const popularityScore = Math.max(
    totalEnrollments,
    Number.isFinite(Number(course?.metrics?.popularityScore))
      ? Number(course.metrics.popularityScore)
      : 0
  );

  return {
    ...presentationCourse,
    curriculum: sanitizeCourseCurriculumForLearner(presentationCourse?.curriculum),
    visibility: {
      type: normalizeCourseVisibilityType(presentationCourse?.visibility?.type),
    },
    assessment: normalizeCourseAssessment(presentationCourse?.assessment),
    metrics: {
      averageRating,
      popularityScore,
      totalEnrollments,
    },
    price: pricingAmount,
    courseType: deriveCourseType(course),
    enrollmentCount: totalEnrollments,
  };
}

function filterCatalogItemsByCourseType(items: any[], courseType: string) {
  if (courseType !== 'scorm' && courseType !== 'standard') {
    return items;
  }

  return items.filter((item) => item.courseType === courseType);
}

function sortCatalogItems(items: any[], sortBy: string) {
  const nextItems = [...items];

  if (sortBy === 'popularity') {
    nextItems.sort((left, right) => (right.metrics?.popularityScore || 0) - (left.metrics?.popularityScore || 0));
    return nextItems;
  }

  if (sortBy === 'price_asc') {
    nextItems.sort((left, right) => (left.price || 0) - (right.price || 0));
    return nextItems;
  }

  if (sortBy === 'price_desc') {
    nextItems.sort((left, right) => (right.price || 0) - (left.price || 0));
    return nextItems;
  }

  if (sortBy === 'highest_rated') {
    nextItems.sort((left, right) => (right.metrics?.averageRating || 0) - (left.metrics?.averageRating || 0));
    return nextItems;
  }

  if (sortBy === 'title_az') {
    nextItems.sort((left, right) => String(left.title || '').localeCompare(String(right.title || '')));
    return nextItems;
  }

  if (sortBy === 'oldest') {
    nextItems.sort(
      (left, right) =>
        new Date(String(left.createdAt || 0)).getTime() - new Date(String(right.createdAt || 0)).getTime()
    );
    return nextItems;
  }

  nextItems.sort(
    (left, right) =>
      new Date(String(right.createdAt || 0)).getTime() - new Date(String(left.createdAt || 0)).getTime()
  );
  return nextItems;
}

router.post(
  '/upload-chunk',
  authenticate,
  chunkUpload.single('chunk'),
  async (req: Request, res: Response) => {
    try {
      const uploadId = String(req.body.uploadId || '').trim();
      const chunkIndex = Number(req.body.chunkIndex);
      const chunkFile = req.file;

      if (!uploadId) {
        return res.status(400).json({ error: 'Upload id is required' });
      }

      if (!chunkFile) {
        return res.status(400).json({ error: 'Chunk file is required' });
      }

      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return res.status(400).json({ error: 'Chunk index must be a non-negative integer' });
      }

      await storeScormUploadChunk(uploadId, chunkIndex, chunkFile.buffer);
      return res.status(200).json({ message: 'Chunk uploaded successfully' });
    } catch (error) {
      console.error('Course chunk upload error:', error);
      return res.status(500).json({ error: 'Failed to upload course file chunk' });
    }
  }
);

router.post(
  '/quiz/preview-excel',
  authenticate,
  quizExcelUpload.single('quizExcel'),
  previewCourseQuizExcelService
);

router.post(
  '/create',
  authenticate,
  upload.fields([
    { name: 'scormZip', maxCount: 100 },
    { name: 'contentMedia', maxCount: 200 },
    { name: 'studyMaterial', maxCount: 400 },
    { name: 'thumbnail', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    let scormChunkUploads: ChunkedAssetUpload[] = [];
    let contentChunkUploads: ChunkedAssetUpload[] = [];
    let studyMaterialChunkUploads: ChunkedAssetUpload[] = [];
    let scormZipFiles: Express.Multer.File[] = [];
    let sectionContentFiles: Express.Multer.File[] = [];
    let studyMaterialFiles: Express.Multer.File[] = [];
    let thumbnailFile: Express.Multer.File | undefined;
    let createdCourseAssetPaths: string[] = [];
    const scormUploadsToProcess: { moduleId: string; sectionId: string; scormPackageId: string; supabasePath: string; }[] = [];

    try {
      ensurePermission((req as any).bodyData, PERMISSION_KEYS.CREATE_COURSES, 'You do not have permission to create courses');
      await ensureCompanyManagementAccess({
        actor: (req as any).bodyData || (req as any).user,
        actionLabel: "manage courses for this company",
        allowSuperadminWithoutCompany: true,
      });
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      scormZipFiles = files?.scormZip || [];
      sectionContentFiles = files?.contentMedia || [];
      studyMaterialFiles = files?.studyMaterial || [];
      thumbnailFile = files?.thumbnail?.[0];
      scormChunkUploads = req.body.scormChunkUploads
        ? JSON.parse(req.body.scormChunkUploads)
        : [];
      contentChunkUploads = req.body.contentChunkUploads
        ? JSON.parse(req.body.contentChunkUploads)
        : [];
      studyMaterialChunkUploads = req.body.studyMaterialChunkUploads
        ? JSON.parse(req.body.studyMaterialChunkUploads)
        : [];

      let payload: any = {};
      if (req.body.payload) {
        payload = JSON.parse(req.body.payload);
      }

      const courseData = payload.course || {};
      const curriculum = payload.curriculum || {};
      const progression = payload.progression || {};
      const commerce = payload.commerce || {};
      const learnerSelection = payload.enrollment?.learnerSelection || {};
      let assessment = normalizeCourseAssessment(courseData.assessment);
      const visibilityType = normalizeCourseVisibilityType(courseData.visibility?.type);
      const createdBy = (req as any).userId;
      const actor = (req as any).bodyData || (req as any).user;
      const actorRole = normalizeActorRole(actor?.role || actor?.userType);
      const scopedCompanyId =
        actorRole === 'superadmin'
          ? String(courseData.companyId || payload.companyId || '').trim()
          : String(actor?.company || actor?.companyId || '').trim();
      const nextCourseStatus = normalizeCourseStatus(payload.action);
      if (!createdBy) {
        return res.status(401).json({ error: 'Authenticated user context is required to create a course' });
      }
      if (nextCourseStatus === 'published' && visibilityType === 'public') {
        if (!mongoose.Types.ObjectId.isValid(scopedCompanyId)) {
          return res.status(422).json({ error: 'Select a company before publishing a public course' });
        }

        const owningCompany = await Company.findOne({
          _id: new mongoose.Types.ObjectId(scopedCompanyId),
          is_active: true,
          deletedAt: { $exists: false },
        }).select('_id').lean();
        if (!owningCompany) {
          return res.status(422).json({ error: 'Select an active company before publishing a public course' });
        }
      }
      const courseCode = await generateUniqueCourseCode(courseData.courseCode);

      let thumbnailUrl = '';
      if (thumbnailFile) {
        try {
          const uploadResult = await cloudinary.uploader.upload(thumbnailFile.path, {
            folder: 'lms/thumbnails',
          });
          thumbnailUrl = uploadResult.secure_url;
        } catch (cloudErr) {
          console.error('Cloudinary upload failed:', cloudErr);
        }
        fs.unlinkSync(thumbnailFile.path);
      }

      let scormFilePath = '';
      const normalizedQuizConfiguration = normalizeCourseQuizConfiguration(curriculum);
      let finalModules = normalizedQuizConfiguration.modules;
      if (assessment.totalMarks === null && normalizedQuizConfiguration.totalMarks > 0) {
        assessment = normalizeCourseAssessment({
          ...assessment,
          totalMarks: normalizedQuizConfiguration.totalMarks,
        });
      }
      let scormFileIndex = 0;
      let sectionContentFileIndex = 0;
      let contentChunkUploadIndex = 0;
      let studyMaterialFileIndex = 0;
      let studyMaterialChunkUploadIndex = 0;
      const consumedScormChunkUploads: ChunkedAssetUpload[] = [];
      const consumedContentChunkUploads: ChunkedAssetUpload[] = [];
      const consumedStudyMaterialChunkUploads: ChunkedAssetUpload[] = [];

      for (const mod of finalModules) {
        const moduleStudyMaterial = Array.isArray(mod.studyMaterial) ? mod.studyMaterial : [];

        for (const material of moduleStudyMaterial) {
          const uploadedStudyMaterial = studyMaterialFiles[studyMaterialFileIndex];
          const chunkedStudyMaterialUpload = studyMaterialChunkUploads[studyMaterialChunkUploadIndex];

          if (!uploadedStudyMaterial && !chunkedStudyMaterialUpload) {
            continue;
          }

          let storedMaterialPath = '';
          if (uploadedStudyMaterial) {
            storedMaterialPath = await storeCourseAssetFile(uploadedStudyMaterial);
          } else {
            storedMaterialPath = await storeChunkedCourseAssetFile(chunkedStudyMaterialUpload);
          }
          createdCourseAssetPaths.push(storedMaterialPath);
          material.previewUrl = storedMaterialPath;

          if (uploadedStudyMaterial) {
            studyMaterialFileIndex += 1;
          } else if (chunkedStudyMaterialUpload) {
            consumedStudyMaterialChunkUploads.push(chunkedStudyMaterialUpload);
            studyMaterialChunkUploadIndex += 1;
          }
        }

        mod.studyMaterial = moduleStudyMaterial.filter((material: any) => hasPreviewUrl(material));

        for (const sec of mod.sections || []) {
          if (sec.content) {
            if (sec.content.kind === 'scorm' || sec.content.kind === 'zip') {
              const uploadedScormZip = scormZipFiles[scormFileIndex];
              const chunkedScormUpload = scormChunkUploads[scormFileIndex];
              if (uploadedScormZip || chunkedScormUpload) {
                let extractedPath = '';
                if (uploadedScormZip) {
                  extractedPath = await extractAndStoreScormPackage(uploadedScormZip);
                } else {
                  extractedPath = await extractAndStoreChunkedScormPackage(chunkedScormUpload);
                }

                createdCourseAssetPaths.push(extractedPath);
                sec.content.previewUrl = extractedPath;

                const scormPackageIdMatch = extractedPath.match(/^\/?([^/]+)/);
                const scormPackageId = scormPackageIdMatch ? scormPackageIdMatch[1] : '';

                if (SCORM_QUESTION_BANK_EXTRACTION_ENABLED && scormPackageId) {
                  const derivedModuleId = deriveModuleId(mod);
                  const derivedSectionId = deriveSectionId(mod, sec);
                  scormUploadsToProcess.push({
                    moduleId: derivedModuleId,
                    sectionId: derivedSectionId,
                    scormPackageId,
                    supabasePath: extractedPath,
                  });
                }

                // Store slide count at creation time so progress computation
                // doesn't need to re-parse SCORM files on every tracking call.
                try {
                  const slideMeta = await getScormAssetSlideMetadata(extractedPath);
                  sec.content.slideCount = slideMeta?.totalSlides ?? null;
                  sec.content.scormMetadata = {
                    totalSlides: slideMeta?.totalSlides ?? null,
                    sourceAssetPath: slideMeta?.sourceAssetPath ?? null,
                  };
                } catch (slideMetaErr) {
                  console.warn('Failed to read SCORM slide metadata at course creation:', slideMetaErr);
                  sec.content.slideCount = null;
                  sec.content.scormMetadata = {
                    totalSlides: null,
                    sourceAssetPath: null,
                  };
                }

                if (!scormFilePath) {
                  scormFilePath = extractedPath;
                }

                if (chunkedScormUpload) {
                  consumedScormChunkUploads.push(chunkedScormUpload);
                }

                scormFileIndex += 1;
              }
            } else {
              const uploadedContentFile = sectionContentFiles[sectionContentFileIndex];
              const chunkedContentUpload = contentChunkUploads[contentChunkUploadIndex];

              if (uploadedContentFile || chunkedContentUpload) {
                let storedContentPath = '';
                if (uploadedContentFile) {
                  storedContentPath = await storeCourseAssetFile(uploadedContentFile);
                } else {
                  storedContentPath = await storeChunkedCourseAssetFile(chunkedContentUpload);
                }
                createdCourseAssetPaths.push(storedContentPath);
                sec.content.previewUrl = storedContentPath;

                if (uploadedContentFile) {
                  sectionContentFileIndex += 1;
                } else if (chunkedContentUpload) {
                  consumedContentChunkUploads.push(chunkedContentUpload);
                  contentChunkUploadIndex += 1;
                }
              }
            }
          }

          if (sec.content && !hasPreviewUrl(sec.content)) {
            sec.content = null;
          }

          const sectionStudyMaterial = Array.isArray(sec.studyMaterial) ? sec.studyMaterial : [];
          for (const material of sectionStudyMaterial) {
            const uploadedStudyMaterial = studyMaterialFiles[studyMaterialFileIndex];
            const chunkedStudyMaterialUpload = studyMaterialChunkUploads[studyMaterialChunkUploadIndex];

            if (!uploadedStudyMaterial && !chunkedStudyMaterialUpload) {
              continue;
            }

            let storedMaterialPath = '';
            if (uploadedStudyMaterial) {
              storedMaterialPath = await storeCourseAssetFile(uploadedStudyMaterial);
            } else {
              storedMaterialPath = await storeChunkedCourseAssetFile(chunkedStudyMaterialUpload);
            }
            createdCourseAssetPaths.push(storedMaterialPath);
            material.previewUrl = storedMaterialPath;

            if (uploadedStudyMaterial) {
              studyMaterialFileIndex += 1;
            } else if (chunkedStudyMaterialUpload) {
              consumedStudyMaterialChunkUploads.push(chunkedStudyMaterialUpload);
              studyMaterialChunkUploadIndex += 1;
            }
          }

          sec.studyMaterial = sectionStudyMaterial.filter((material: any) => hasPreviewUrl(material));
        }
      }

      if (scormZipFiles.length > scormFileIndex) {
        for (const unusedZip of scormZipFiles.slice(scormFileIndex)) {
          if (fs.existsSync(unusedZip.path)) {
            fs.unlinkSync(unusedZip.path);
          }
        }
      }

      if (sectionContentFiles.length > sectionContentFileIndex) {
        for (const unusedContentFile of sectionContentFiles.slice(sectionContentFileIndex)) {
          cleanupUploadedTempFile(unusedContentFile);
        }
      }

      if (studyMaterialFiles.length > studyMaterialFileIndex) {
        for (const unusedStudyMaterial of studyMaterialFiles.slice(studyMaterialFileIndex)) {
          cleanupUploadedTempFile(unusedStudyMaterial);
        }
      }

      const unusedChunkUploads = [
        ...scormChunkUploads.slice(consumedScormChunkUploads.length),
        ...contentChunkUploads.slice(consumedContentChunkUploads.length),
        ...studyMaterialChunkUploads.slice(consumedStudyMaterialChunkUploads.length),
      ];

      if (unusedChunkUploads.length > 0) {
        await cleanupChunkUploads(unusedChunkUploads, 'Failed to clean up unused course upload chunks.');
      }

      const course = new Course({
        courseCode,
        title: courseData.title || 'Untitled Course',
        slug: courseData.slug || '',
        createdBy,
        description: courseData.description || { text: '', html: '' },
        highlights: normalizeCourseHighlights(courseData.highlights),
        instructor: normalizeCourseInstructorForStorage(courseData.instructor),
        taxonomy: courseData.taxonomy || { languages: [], categories: [], level: 'Beginner' },
        visibility: {
          type: visibilityType,
        },
        assessment,
        metrics: {
          averageRating: Number.isFinite(Number(courseData.metrics?.averageRating))
            ? Number(courseData.metrics.averageRating)
            : null,
          popularityScore: Number.isFinite(Number(courseData.metrics?.popularityScore))
            ? Number(courseData.metrics.popularityScore)
            : 0,
          totalEnrollments: Number.isFinite(Number(courseData.metrics?.totalEnrollments))
            ? Number(courseData.metrics.totalEnrollments)
            : 0,
        },
        thumbnailUrl: thumbnailUrl || courseData.media?.thumbnail?.previewUrl || '',
        scormFilePath,
        company: scopedCompanyId && mongoose.Types.ObjectId.isValid(scopedCompanyId)
          ? new mongoose.Types.ObjectId(scopedCompanyId)
          : undefined,
        curriculum: {
          quizStrategy: normalizedQuizConfiguration.quizStrategy,
          totalModules: curriculum.totalModules || 0,
          totalSections: curriculum.totalSections || 0,
          finalQuiz: normalizedQuizConfiguration.finalQuiz,
          modules: finalModules,
        },
        progression: {
          completionWindowDays: progression.completionWindowDays ?? null,
          dripEnabled: progression.dripEnabled ?? false,
          certificateEnabled: progression.certificateEnabled ?? true,
          certificateTemplateId: normalizeOptionalObjectId(progression.certificateTemplateId),
          mandatoryModules: progression.mandatoryModules ?? true,
        },
        commerce: {
          pricingModel: commerce.pricingModel || 'free',
          currency: commerce.currency || 'INR',
          amountInRupees: commerce.amountInRupees ?? null,
          accessDurationDays: commerce.accessDurationDays ?? null,
          companyAccess: Array.isArray(commerce.companyAccess) ? commerce.companyAccess : [],
        },
        enrollment: {
          learnerSelection: {
            totalSelected: Number(learnerSelection.totalSelected) || 0,
            selectedLearners: Array.isArray(learnerSelection.selectedLearners) ? learnerSelection.selectedLearners : [],
          },
        },
        status: nextCourseStatus,
      });

      await course.save();

      if (SCORM_QUESTION_BANK_EXTRACTION_ENABLED) {
        for (const upload of scormUploadsToProcess) {
          processScormQuestionBank({
            courseId: course._id.toString(),
            moduleId: upload.moduleId,
            sectionId: upload.sectionId,
            scormPackageId: upload.scormPackageId,
            supabasePath: upload.supabasePath,
          }).catch((err) => {
            console.error(`Failed to process SCORM question bank for package ${upload.scormPackageId}:`, err);
          });
        }
      }

      return res.status(200).json({ message: 'Course created successfully', data: course });
    } catch (error) {
      console.error('Course create error:', error);

      if (createdCourseAssetPaths.length > 0) {
        await deleteScormAssetsByPaths(createdCourseAssetPaths).catch((cleanupError) => {
          console.warn('Failed to clean up SCORM assets after create error.', cleanupError);
        });
      }

      await cleanupChunkUploads(
        [...scormChunkUploads, ...contentChunkUploads, ...studyMaterialChunkUploads],
        'Failed to clean up course upload chunks after create error.'
      );

      for (const uploadedZip of scormZipFiles) {
        cleanupUploadedTempFile(uploadedZip);
      }

      for (const uploadedContentFile of sectionContentFiles) {
        cleanupUploadedTempFile(uploadedContentFile);
      }

      for (const uploadedStudyMaterial of studyMaterialFiles) {
        cleanupUploadedTempFile(uploadedStudyMaterial);
      }

      cleanupUploadedTempFile(thumbnailFile);

      return res.status(500).json({ error: 'Failed to create course' });
    }
  }
);

router.get('/next-course-code', authenticate, async (req: Request, res: Response) => {
  try {
    ensurePermission((req as any).bodyData, PERMISSION_KEYS.CREATE_COURSES, 'You do not have permission to create courses');
    const courseCode = await generateUniqueCourseCode();
    return res.status(200).json({
      status: 'success',
      message: 'Course ID generated successfully',
      data: {
        courseCode,
      },
    });
  } catch (error) {
    console.error('Course ID generation error:', error);
    return res.status(500).json({ error: 'Failed to generate course ID' });
  }
});

router.get('/public', async (req: Request, res: Response) => {
  try {
    const filters = normalizeCatalogFilters(req.query);
    const baseQuery = buildBaseCourseQuery({
      ...filters,
      status: 'published',
      visibilityType: 'public',
    });

    const courses = await Course.find({
      ...baseQuery,
      status: 'published',
      'visibility.type': 'public',
    })
      .populate(coursePresentationPopulate as any)
      .sort({ createdAt: -1 })
      .lean();

    const enrollmentCountMap = await buildCourseEnrollmentCountMap(
      courses.map((course: any) => String(course._id))
    );
    const catalogItems = sortCatalogItems(
      filterCatalogItemsByCourseType(
        courses.map((course: any) =>
          serializeCourseCatalogItem(course, enrollmentCountMap.get(String(course._id)) || 0)
        ),
        filters.courseType
      ),
      filters.sortBy
    );

    return res.status(200).json({
      data: catalogItems,
      meta: {
        total: catalogItems.length,
        filters,
      },
    });
  } catch (error) {
    console.error('Public course catalog error:', error);
    return res.status(500).json({ error: 'Failed to fetch public courses' });
  }
});

router.get('/:courseId/quizzes', authenticate, getLearnerCourseQuizzesService);
router.post('/:courseId/quizzes/:quizId/submit', authenticate, submitLearnerCourseQuizService);

router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).bodyData || (req as any).user;
    ensureCourseViewPermission(actor, 'You do not have permission to view courses');
    const filters = normalizeCatalogFilters(req.query);
    const baseQuery = buildBaseCourseQuery(filters);
    const visibilityScope = await getVisibleCourseScopeForUser(actor);
    if (!visibilityScope.isGlobal && !visibilityScope.courseIds.length) {
      return res.status(200).json({
        data: [],
        meta: {
          total: 0,
          filters,
        },
      });
    }

    const scopedQuery = visibilityScope.isGlobal
      ? baseQuery
      : {
          ...baseQuery,
          _id: { $in: toObjectIdList(visibilityScope.courseIds) },
        };

    const courses = await Course.find(scopedQuery)
      .populate(coursePresentationPopulate as any)
      .sort({ createdAt: -1 })
      .lean();
    const enrollmentCountMap = await buildCourseEnrollmentCountMap(
      courses.map((course: any) => String(course._id))
    );
    const catalogItems = sortCatalogItems(
      filterCatalogItemsByCourseType(
        courses.map((course: any) =>
          serializeCourseCatalogItem(course, enrollmentCountMap.get(String(course._id)) || 0)
        ),
        filters.courseType
      ),
      filters.sortBy
    );

    return res.status(200).json({
      data: catalogItems,
      meta: {
        total: catalogItems.length,
        filters,
      },
    });
  } catch (error) {
    console.error('Course list error:', error);
    return res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

router.put(
  '/:id',
  authenticate,
  upload.fields([
    { name: 'scormZip', maxCount: 100 },
    { name: 'contentMedia', maxCount: 200 },
    { name: 'studyMaterial', maxCount: 400 },
    { name: 'thumbnail', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    let scormChunkUploads: ChunkedAssetUpload[] = [];
    let contentChunkUploads: ChunkedAssetUpload[] = [];
    let studyMaterialChunkUploads: ChunkedAssetUpload[] = [];
    let scormZipFiles: Express.Multer.File[] = [];
    let sectionContentFiles: Express.Multer.File[] = [];
    let studyMaterialFiles: Express.Multer.File[] = [];
    let thumbnailFile: Express.Multer.File | undefined;
    let createdCourseAssetPaths: string[] = [];
    const scormUploadsToProcess: { moduleId: string; sectionId: string; scormPackageId: string; supabasePath: string; }[] = [];

    try {
      const courseId = String(req.params.id || '').trim();
      if (!mongoose.Types.ObjectId.isValid(courseId)) {
        return res.status(400).json({ error: 'Invalid course id' });
      }

      const actor = (req as any).bodyData || (req as any).user;
      const actorRole = normalizeActorRole(actor?.role || actor?.userType || (req as any).user?.role);
      ensurePermission(actor, PERMISSION_KEYS.EDIT_COURSES, 'You do not have permission to edit courses');
      if (actorRole !== 'superadmin') {
        return res.status(403).json({ error: 'Only super admins can edit course details' });
      }

      await ensureCompanyManagementAccess({
        actor,
        actionLabel: "manage courses for this company",
        allowSuperadminWithoutCompany: true,
      });

      const course = await Course.findById(courseId);
      if (!course) {
        return res.status(404).json({ error: 'Course not found' });
      }
      const previousCompanyId = String(course.company || '').trim();

      const previousAssetPaths = collectCourseAssetPathsFromCurriculum(course.curriculum);
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      scormZipFiles = files?.scormZip || [];
      sectionContentFiles = files?.contentMedia || [];
      studyMaterialFiles = files?.studyMaterial || [];
      thumbnailFile = files?.thumbnail?.[0];
      scormChunkUploads = req.body.scormChunkUploads
        ? JSON.parse(req.body.scormChunkUploads)
        : [];
      contentChunkUploads = req.body.contentChunkUploads
        ? JSON.parse(req.body.contentChunkUploads)
        : [];
      studyMaterialChunkUploads = req.body.studyMaterialChunkUploads
        ? JSON.parse(req.body.studyMaterialChunkUploads)
        : [];

      let payload: any = {};
      if (req.body.payload) {
        payload = JSON.parse(req.body.payload);
      }

      const courseData = payload.course || {};
      const curriculum = payload.curriculum || {};
      const progression = payload.progression || {};
      const commerce = payload.commerce || {};
      const learnerSelection = payload.enrollment?.learnerSelection || course.enrollment?.learnerSelection || {};
      let assessment = normalizeCourseAssessment(courseData.assessment);
      const visibilityType = normalizeCourseVisibilityType(courseData.visibility?.type);
      const scopedCompanyId = String(courseData.companyId || payload.companyId || course.company || '').trim();
      const nextCourseStatus = normalizeCourseStatus(payload.action);
      if (nextCourseStatus === 'published' && visibilityType === 'public') {
        if (!mongoose.Types.ObjectId.isValid(scopedCompanyId)) {
          return res.status(422).json({ error: 'Select a company before publishing a public course' });
        }

        const owningCompany = await Company.findOne({
          _id: new mongoose.Types.ObjectId(scopedCompanyId),
          is_active: true,
          deletedAt: { $exists: false },
        }).select('_id').lean();
        if (!owningCompany) {
          return res.status(422).json({ error: 'Select an active company before publishing a public course' });
        }
      }
      const courseCode = await resolveEditableCourseCode(
        course._id as mongoose.Types.ObjectId,
        courseData.courseCode,
        course.courseCode
      );

      let thumbnailUrl = String(courseData.media?.thumbnail?.previewUrl || '').trim();
      if (thumbnailFile) {
        try {
          const uploadResult = await cloudinary.uploader.upload(thumbnailFile.path, {
            folder: 'lms/thumbnails',
          });
          thumbnailUrl = uploadResult.secure_url;
        } catch (cloudErr) {
          console.error('Cloudinary upload failed:', cloudErr);
        }
        cleanupUploadedTempFile(thumbnailFile);
      }

      const normalizedQuizConfiguration = normalizeCourseQuizConfiguration(curriculum);
      let finalModules = normalizedQuizConfiguration.modules;
      if (assessment.totalMarks === null && normalizedQuizConfiguration.totalMarks > 0) {
        assessment = normalizeCourseAssessment({
          ...assessment,
          totalMarks: normalizedQuizConfiguration.totalMarks,
        });
      }

      let scormFilePath = '';
      let scormFileIndex = 0;
      let sectionContentFileIndex = 0;
      let contentChunkUploadIndex = 0;
      let studyMaterialFileIndex = 0;
      let studyMaterialChunkUploadIndex = 0;
      const consumedScormChunkUploads: ChunkedAssetUpload[] = [];
      const consumedContentChunkUploads: ChunkedAssetUpload[] = [];
      const consumedStudyMaterialChunkUploads: ChunkedAssetUpload[] = [];

      for (const mod of finalModules) {
        const moduleStudyMaterial = Array.isArray(mod.studyMaterial) ? mod.studyMaterial : [];

        for (const material of moduleStudyMaterial) {
          if (hasPreviewUrl(material)) {
            continue;
          }

          const uploadedStudyMaterial = studyMaterialFiles[studyMaterialFileIndex];
          const chunkedStudyMaterialUpload = studyMaterialChunkUploads[studyMaterialChunkUploadIndex];

          if (!uploadedStudyMaterial && !chunkedStudyMaterialUpload) {
            continue;
          }

          let storedMaterialPath = '';
          if (uploadedStudyMaterial) {
            storedMaterialPath = await storeCourseAssetFile(uploadedStudyMaterial);
          } else {
            storedMaterialPath = await storeChunkedCourseAssetFile(chunkedStudyMaterialUpload);
          }
          createdCourseAssetPaths.push(storedMaterialPath);
          material.previewUrl = storedMaterialPath;

          if (uploadedStudyMaterial) {
            studyMaterialFileIndex += 1;
          } else if (chunkedStudyMaterialUpload) {
            consumedStudyMaterialChunkUploads.push(chunkedStudyMaterialUpload);
            studyMaterialChunkUploadIndex += 1;
          }
        }

        mod.studyMaterial = moduleStudyMaterial.filter((material: any) => hasPreviewUrl(material));

        for (const sec of mod.sections || []) {
          if (sec.content) {
            if (hasPreviewUrl(sec.content)) {
              if (!scormFilePath && (sec.content.kind === 'scorm' || sec.content.kind === 'zip')) {
                scormFilePath = String(sec.content.previewUrl || '').trim();
              }
            } else if (sec.content.kind === 'scorm' || sec.content.kind === 'zip') {
              const uploadedScormZip = scormZipFiles[scormFileIndex];
              const chunkedScormUpload = scormChunkUploads[scormFileIndex];
              if (uploadedScormZip || chunkedScormUpload) {
                let extractedPath = '';
                if (uploadedScormZip) {
                  extractedPath = await extractAndStoreScormPackage(uploadedScormZip);
                } else {
                  extractedPath = await extractAndStoreChunkedScormPackage(chunkedScormUpload);
                }

                createdCourseAssetPaths.push(extractedPath);
                sec.content.previewUrl = extractedPath;

                const scormPackageIdMatch = extractedPath.match(/^\/?([^/]+)/);
                const scormPackageId = scormPackageIdMatch ? scormPackageIdMatch[1] : '';

                if (SCORM_QUESTION_BANK_EXTRACTION_ENABLED && scormPackageId) {
                  const derivedModuleId = deriveModuleId(mod);
                  const derivedSectionId = deriveSectionId(mod, sec);
                  scormUploadsToProcess.push({
                    moduleId: derivedModuleId,
                    sectionId: derivedSectionId,
                    scormPackageId,
                    supabasePath: extractedPath,
                  });
                }

                try {
                  const slideMeta = await getScormAssetSlideMetadata(extractedPath);
                  sec.content.slideCount = slideMeta?.totalSlides ?? null;
                  sec.content.scormMetadata = {
                    totalSlides: slideMeta?.totalSlides ?? null,
                    sourceAssetPath: slideMeta?.sourceAssetPath ?? null,
                  };
                } catch (slideMetaErr) {
                  console.warn('Failed to read SCORM slide metadata at course update:', slideMetaErr);
                  sec.content.slideCount = null;
                  sec.content.scormMetadata = {
                    totalSlides: null,
                    sourceAssetPath: null,
                  };
                }

                if (!scormFilePath) {
                  scormFilePath = extractedPath;
                }

                if (chunkedScormUpload) {
                  consumedScormChunkUploads.push(chunkedScormUpload);
                }

                scormFileIndex += 1;
              }
            } else {
              const uploadedContentFile = sectionContentFiles[sectionContentFileIndex];
              const chunkedContentUpload = contentChunkUploads[contentChunkUploadIndex];

              if (uploadedContentFile || chunkedContentUpload) {
                let storedContentPath = '';
                if (uploadedContentFile) {
                  storedContentPath = await storeCourseAssetFile(uploadedContentFile);
                } else {
                  storedContentPath = await storeChunkedCourseAssetFile(chunkedContentUpload);
                }
                createdCourseAssetPaths.push(storedContentPath);
                sec.content.previewUrl = storedContentPath;

                if (uploadedContentFile) {
                  sectionContentFileIndex += 1;
                } else if (chunkedContentUpload) {
                  consumedContentChunkUploads.push(chunkedContentUpload);
                  contentChunkUploadIndex += 1;
                }
              }
            }
          }

          if (sec.content && !hasPreviewUrl(sec.content)) {
            sec.content = null;
          }

          const sectionStudyMaterial = Array.isArray(sec.studyMaterial) ? sec.studyMaterial : [];
          for (const material of sectionStudyMaterial) {
            if (hasPreviewUrl(material)) {
              continue;
            }

            const uploadedStudyMaterial = studyMaterialFiles[studyMaterialFileIndex];
            const chunkedStudyMaterialUpload = studyMaterialChunkUploads[studyMaterialChunkUploadIndex];

            if (!uploadedStudyMaterial && !chunkedStudyMaterialUpload) {
              continue;
            }

            let storedMaterialPath = '';
            if (uploadedStudyMaterial) {
              storedMaterialPath = await storeCourseAssetFile(uploadedStudyMaterial);
            } else {
              storedMaterialPath = await storeChunkedCourseAssetFile(chunkedStudyMaterialUpload);
            }
            createdCourseAssetPaths.push(storedMaterialPath);
            material.previewUrl = storedMaterialPath;

            if (uploadedStudyMaterial) {
              studyMaterialFileIndex += 1;
            } else if (chunkedStudyMaterialUpload) {
              consumedStudyMaterialChunkUploads.push(chunkedStudyMaterialUpload);
              studyMaterialChunkUploadIndex += 1;
            }
          }

          sec.studyMaterial = sectionStudyMaterial.filter((material: any) => hasPreviewUrl(material));
        }
      }

      if (!scormFilePath) {
        scormFilePath = findFirstScormPathFromModules(finalModules);
      }

      if (scormZipFiles.length > scormFileIndex) {
        for (const unusedZip of scormZipFiles.slice(scormFileIndex)) {
          cleanupUploadedTempFile(unusedZip);
        }
      }

      if (sectionContentFiles.length > sectionContentFileIndex) {
        for (const unusedContentFile of sectionContentFiles.slice(sectionContentFileIndex)) {
          cleanupUploadedTempFile(unusedContentFile);
        }
      }

      if (studyMaterialFiles.length > studyMaterialFileIndex) {
        for (const unusedStudyMaterial of studyMaterialFiles.slice(studyMaterialFileIndex)) {
          cleanupUploadedTempFile(unusedStudyMaterial);
        }
      }

      const unusedChunkUploads = [
        ...scormChunkUploads.slice(consumedScormChunkUploads.length),
        ...contentChunkUploads.slice(consumedContentChunkUploads.length),
        ...studyMaterialChunkUploads.slice(consumedStudyMaterialChunkUploads.length),
      ];

      if (unusedChunkUploads.length > 0) {
        await cleanupChunkUploads(unusedChunkUploads, 'Failed to clean up unused course upload chunks.');
      }

      course.set({
        courseCode,
        title: courseData.title || course.title || 'Untitled Course',
        slug: courseData.slug || '',
        description: courseData.description || { text: '', html: '' },
        highlights: normalizeCourseHighlights(courseData.highlights),
        instructor: normalizeCourseInstructorForStorage(courseData.instructor),
        taxonomy: courseData.taxonomy || { languages: [], categories: [], level: 'Beginner' },
        visibility: {
          type: visibilityType,
        },
        assessment,
        metrics: {
          averageRating: Number.isFinite(Number(courseData.metrics?.averageRating))
            ? Number(courseData.metrics.averageRating)
            : course.metrics?.averageRating ?? null,
          popularityScore: Number.isFinite(Number(courseData.metrics?.popularityScore))
            ? Number(courseData.metrics.popularityScore)
            : course.metrics?.popularityScore ?? 0,
          totalEnrollments: Number.isFinite(Number(courseData.metrics?.totalEnrollments))
            ? Number(courseData.metrics.totalEnrollments)
            : course.metrics?.totalEnrollments ?? 0,
        },
        thumbnailUrl,
        scormFilePath,
        company: scopedCompanyId && mongoose.Types.ObjectId.isValid(scopedCompanyId)
          ? new mongoose.Types.ObjectId(scopedCompanyId)
          : course.company,
        curriculum: {
          quizStrategy: normalizedQuizConfiguration.quizStrategy,
          totalModules: Number(curriculum.totalModules ?? finalModules.length) || 0,
          totalSections:
            Number(curriculum.totalSections ?? finalModules.reduce((count: number, moduleItem: any) => count + (moduleItem.sections?.length || 0), 0)) || 0,
          finalQuiz: normalizedQuizConfiguration.finalQuiz,
          modules: finalModules,
        },
        progression: {
          completionWindowDays: progression.completionWindowDays ?? null,
          dripEnabled: progression.dripEnabled ?? false,
          certificateEnabled: progression.certificateEnabled ?? true,
          certificateTemplateId: Object.prototype.hasOwnProperty.call(progression, 'certificateTemplateId')
            ? normalizeOptionalObjectId(progression.certificateTemplateId)
            : course.progression?.certificateTemplateId || null,
          mandatoryModules: progression.mandatoryModules ?? true,
        },
        commerce: {
          pricingModel: commerce.pricingModel || 'free',
          currency: commerce.currency || 'INR',
          amountInRupees: commerce.amountInRupees ?? null,
          accessDurationDays: commerce.accessDurationDays ?? null,
          companyAccess: Array.isArray(commerce.companyAccess) ? commerce.companyAccess : course.commerce?.companyAccess || [],
        },
        enrollment: {
          learnerSelection: {
            totalSelected: Number(learnerSelection.totalSelected) || 0,
            selectedLearners: Array.isArray(learnerSelection.selectedLearners) ? learnerSelection.selectedLearners : [],
          },
        },
        status: nextCourseStatus,
      });

      await course.save();

      if (nextCourseStatus === 'published' && visibilityType === 'public' && course.company) {
        await syncCourseMembershipsForExistingEnrollments({
          courseId: String(course._id),
          companyId: course.company,
          previousCompanyId,
        });
      }

      const nextAssetPaths = collectCourseAssetPathsFromCurriculum(course.curriculum);
      const nextAssetPathSet = new Set(nextAssetPaths);
      const obsoleteAssetPaths = previousAssetPaths.filter((assetPath) => !nextAssetPathSet.has(assetPath));
      if (obsoleteAssetPaths.length > 0) {
        await deleteScormAssetsByPaths(obsoleteAssetPaths).catch((cleanupError) => {
          console.warn('Failed to clean up replaced course assets after update.', cleanupError);
        });
      }

      if (SCORM_QUESTION_BANK_EXTRACTION_ENABLED) {
        for (const upload of scormUploadsToProcess) {
          processScormQuestionBank({
            courseId: course._id.toString(),
            moduleId: upload.moduleId,
            sectionId: upload.sectionId,
            scormPackageId: upload.scormPackageId,
            supabasePath: upload.supabasePath,
          }).catch((err) => {
            console.error(`Failed to process SCORM question bank for package ${upload.scormPackageId}:`, err);
          });
        }
      }

      return res.status(200).json({ message: 'Course updated successfully', data: course });
    } catch (error: any) {
      console.error('Course update error:', error);
      const isDuplicateCourseCode = error?.message === 'COURSE_CODE_EXISTS';

      if (createdCourseAssetPaths.length > 0) {
        await deleteScormAssetsByPaths(createdCourseAssetPaths).catch((cleanupError) => {
          console.warn('Failed to clean up course assets after update error.', cleanupError);
        });
      }

      await cleanupChunkUploads(
        [...scormChunkUploads, ...contentChunkUploads, ...studyMaterialChunkUploads],
        'Failed to clean up course upload chunks after update error.'
      );

      for (const uploadedZip of scormZipFiles) {
        cleanupUploadedTempFile(uploadedZip);
      }

      for (const uploadedContentFile of sectionContentFiles) {
        cleanupUploadedTempFile(uploadedContentFile);
      }

      for (const uploadedStudyMaterial of studyMaterialFiles) {
        cleanupUploadedTempFile(uploadedStudyMaterial);
      }

      cleanupUploadedTempFile(thumbnailFile);

      if (isDuplicateCourseCode) {
        return res.status(409).json({ error: 'Another course already uses this course ID' });
      }

      return res.status(500).json({ error: 'Failed to update course' });
    }
  }
);

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const actor = (req as any).bodyData || (req as any).user;
    ensureCourseViewPermission(actor, 'You do not have permission to view courses');
    const visibilityScope = await getVisibleCourseScopeForUser(actor);
    if (!visibilityScope.isGlobal && !visibilityScope.courseIds.includes(String(req.params.id || '').trim())) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const course = await Course.findById(req.params.id)
      .populate(coursePresentationPopulate as any)
      .lean();
    if (!course) return res.status(404).json({ error: 'Course not found' });
    return res.status(200).json({ data: serializeCoursePresentation(course) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch course' });
  }
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    ensurePermission((req as any).bodyData, PERMISSION_KEYS.DELETE_COURSES, 'You do not have permission to delete courses');
    await ensureCompanyManagementAccess({
      actor: (req as any).bodyData || (req as any).user,
      actionLabel: "manage courses for this company",
      allowSuperadminWithoutCompany: true,
    });
    const actor = (req as any).bodyData || (req as any).user;
    const role = normalizeActorRole((req as any).user?.role || (req as any).bodyData?.role || "");
    const visibilityScope = await getVisibleCourseScopeForUser(actor);
    const course = await Course.findById(req.params.id);

    if (!course) return res.status(404).json({ error: 'Course not found' });

    if (role !== 'superadmin') {
      const courseId = String(course._id);
      const adminOwnedCourseIds = new Set(visibilityScope.companyCreatedCourseIds || []);
      const departmentHeadOwnedCourseIds = new Set(visibilityScope.selfCreatedCourseIds || []);

      const isAllowedForAdmin = role === 'admin' && adminOwnedCourseIds.has(courseId);
      const isAllowedForDepartmentHead = role === 'departmenthead' && departmentHeadOwnedCourseIds.has(courseId);

      if (!isAllowedForAdmin && !isAllowedForDepartmentHead) {
        return res.status(403).json({ error: 'You can only delete courses created within your allowed scope' });
      }
    }

    const isAssigned = await CourseAccess.exists({ courseId: course._id, companyId: { $ne: null } });
    if (isAssigned) {
      return res.status(403).json({ error: 'Cannot delete course as it is assigned to one or more companies. Revoke assignments first.' });
    }

    await deleteCourseScormAssets(course);
    await course.deleteOne();

    return res.status(200).json({ message: 'Course deleted successfully' });
  } catch (error) {
    console.error('Course delete error:', error);
    return res.status(500).json({ error: 'Failed to delete course' });
  }
});

export default router;
