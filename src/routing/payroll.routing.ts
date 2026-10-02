import express from "express";
import multer from "multer";
import authenticate from "../modules/config/authenticate";
import {
  archiveSalaryComponentService,
  createSalaryComponentService,
  listPayrollAuditLogsService,
  listSalaryComponentsService,
  restoreSalaryComponentService,
  updateSalaryComponentService,
} from "../services/payroll/salaryComponent.service";
import {
  archiveSalaryStructureService,
  cancelSalaryStructureDraftService,
  createSalaryStructureService,
  createSalaryStructureVersionService,
  getPayrollSettingsService,
  getSalaryStructureService,
  listSalaryStructuresService,
  previewSalaryStructureService,
  publishSalaryStructureVersionService,
  restoreSalaryStructureService,
  updatePayrollSettingsService,
  updateSalaryStructureDraftService,
} from "../services/payroll/salaryStructure.service";
import {
  cancelFutureCompensationAssignmentService,
  createEmployeeCompensationAssignmentService,
  getEmployeeCompensationHistoryService,
  getMyCompensationService,
  listCompensationEmployeesService,
  previewEmployeeCompensationService,
} from "../services/payroll/employeeCompensation.service";
import {
  commitCompensationImportService,
  downloadCompensationImportTemplateService,
  listCompensationImportBatchesService,
  listCompensationImportRowsService,
  previewCompensationImportService,
} from "../services/payroll/employeeCompensationImport.service";
import {
  createPayrollRunService,
  getPayrollRunService,
  getPayrollRunSourceService,
  listPayrollRunsService,
} from "../services/payroll/payrollRun.service";
import {
  listPayrollEmployeeInputsService,
  preparePayrollEmployeeInputsService,
} from "../services/payroll/payrollEmployeeInput.service";
import {
  cancelPayrollOneTimeInputService,
  createPayrollOneTimeInputService,
  listPayrollOneTimeInputsService,
} from "../services/payroll/payrollOneTimeInput.service";
import {
  listPayrollEmployeeSnapshotsService,
  preparePayrollEmployeeSnapshotsService,
} from "../services/payroll/payrollEmployeeSnapshot.service";
import {
  calculateDraftPayrollService,
  listDraftPayrollResultsService,
} from "../services/payroll/payrollCalculation.service";
import {
  decidePayrollValidationIssueService,
  listPayrollValidationIssuesService,
} from "../services/payroll/payrollValidation.service";

const payrollRouting = express.Router();
const compensationImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const name = String(file.originalname || "").toLowerCase();
    callback(null, name.endsWith(".csv") || name.endsWith(".xlsx"));
  },
});

payrollRouting.use(authenticate);
payrollRouting.get("/components", listSalaryComponentsService);
payrollRouting.post("/components", createSalaryComponentService);
payrollRouting.patch("/components/:componentId", updateSalaryComponentService);
payrollRouting.post("/components/:componentId/archive", archiveSalaryComponentService);
payrollRouting.post("/components/:componentId/restore", restoreSalaryComponentService);
payrollRouting.get("/settings", getPayrollSettingsService);
payrollRouting.patch("/settings", updatePayrollSettingsService);
payrollRouting.get("/structures", listSalaryStructuresService);
payrollRouting.post("/structures/preview", previewSalaryStructureService);
payrollRouting.post("/structures", createSalaryStructureService);
payrollRouting.get("/structures/:structureId", getSalaryStructureService);
payrollRouting.patch("/structures/:structureId/versions/:versionId", updateSalaryStructureDraftService);
payrollRouting.post("/structures/:structureId/versions", createSalaryStructureVersionService);
payrollRouting.post("/structures/:structureId/versions/:versionId/publish", publishSalaryStructureVersionService);
payrollRouting.post("/structures/:structureId/versions/:versionId/cancel", cancelSalaryStructureDraftService);
payrollRouting.post("/structures/:structureId/archive", archiveSalaryStructureService);
payrollRouting.post("/structures/:structureId/restore", restoreSalaryStructureService);
payrollRouting.get("/compensation/me", getMyCompensationService);
payrollRouting.get("/compensation/employees", listCompensationEmployeesService);
payrollRouting.get("/compensation/employees/:employeeId", getEmployeeCompensationHistoryService);
payrollRouting.post("/compensation/preview", previewEmployeeCompensationService);
payrollRouting.post("/compensation/assignments", createEmployeeCompensationAssignmentService);
payrollRouting.post("/compensation/assignments/:assignmentId/cancel", cancelFutureCompensationAssignmentService);
payrollRouting.get("/compensation/import/template", downloadCompensationImportTemplateService);
payrollRouting.post("/compensation/import/preview", compensationImport.single("file"), previewCompensationImportService);
payrollRouting.get("/compensation/import", listCompensationImportBatchesService);
payrollRouting.get("/compensation/import/:batchId", listCompensationImportRowsService);
payrollRouting.post("/compensation/import/:batchId/commit", commitCompensationImportService);
payrollRouting.get("/runs/source/:periodKey", getPayrollRunSourceService);
payrollRouting.get("/runs", listPayrollRunsService);
payrollRouting.post("/runs", createPayrollRunService);
payrollRouting.get("/runs/:runId/employee-inputs", listPayrollEmployeeInputsService);
payrollRouting.post("/runs/:runId/prepare-attendance-inputs", preparePayrollEmployeeInputsService);
payrollRouting.get("/runs/:runId/employee-snapshots", listPayrollEmployeeSnapshotsService);
payrollRouting.post("/runs/:runId/prepare-employee-snapshots", preparePayrollEmployeeSnapshotsService);
payrollRouting.get("/runs/:runId/results", listDraftPayrollResultsService);
payrollRouting.post("/runs/:runId/calculate", calculateDraftPayrollService);
payrollRouting.get("/runs/:runId/validation", listPayrollValidationIssuesService);
payrollRouting.post("/runs/:runId/validation/:resultId/issues/:issueCode/decision", decidePayrollValidationIssueService);
payrollRouting.get("/runs/:runId/one-time-inputs", listPayrollOneTimeInputsService);
payrollRouting.post("/runs/:runId/one-time-inputs", createPayrollOneTimeInputService);
payrollRouting.post("/runs/:runId/one-time-inputs/:inputId/cancel", cancelPayrollOneTimeInputService);
payrollRouting.get("/runs/:runId", getPayrollRunService);
payrollRouting.get("/audit", listPayrollAuditLogsService);

export default payrollRouting;

