import { NextFunction, Response } from "express";
import mongoose from "mongoose";
import { generateError } from "../../config/Error/functions";
import SalaryComponent, {
  SALARY_COMPONENT_CATEGORIES,
  SalaryComponentCategory,
} from "../../schemas/Payroll/SalaryComponent.schema";
import PayrollAuditLog, { PAYROLL_AUDIT_ENTITY_TYPES } from "../../schemas/Payroll/PayrollAuditLog.schema";
import {
  ensurePayrollConfigurationManager,
  ensurePayrollViewer,
  getPayrollActorId,
  resolvePayrollCompany,
  writePayrollAudit,
} from "./payroll.utils";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normalizeSalaryComponentPayload(body: any) {
  const category = String(body?.category || "").trim().toLowerCase() as SalaryComponentCategory;
  return {
    name: String(body?.name || "").trim(),
    code: String(body?.code || "").trim().toUpperCase(),
    description: String(body?.description || "").trim(),
    category,
    taxable: ["earning", "reimbursement"].includes(category) && body?.taxable === true,
    prorateOnUnpaidDays: body?.prorateOnUnpaidDays !== false,
    displayOrder: Number.isFinite(Number(body?.displayOrder)) ? Number(body.displayOrder) : 0,
  };
}

export function validateSalaryComponentPayload(payload: ReturnType<typeof normalizeSalaryComponentPayload>) {
  if (payload.name.length < 2 || payload.name.length > 100) {
    throw generateError("Component name must be between 2 and 100 characters", 422);
  }
  if (!/^[A-Z][A-Z0-9_]{1,29}$/.test(payload.code)) {
    throw generateError("Code must be 2-30 characters and use uppercase letters, numbers, or underscores", 422);
  }
  if (!SALARY_COMPONENT_CATEGORIES.includes(payload.category)) {
    throw generateError("Invalid salary component category", 422);
  }
  if (payload.description.length > 500) {
    throw generateError("Description cannot exceed 500 characters", 422);
  }
  if (!Number.isInteger(payload.displayOrder) || payload.displayOrder < 0) {
    throw generateError("Display order must be a non-negative whole number", 422);
  }
}

function componentSnapshot(component: any) {
  return {
    name: component.name,
    code: component.code,
    description: component.description || "",
    category: component.category,
    taxable: Boolean(component.taxable),
    prorateOnUnpaidDays: Boolean(component.prorateOnUnpaidDays),
    status: component.status,
    displayOrder: component.displayOrder || 0,
  };
}

async function getScopedComponent(req: any, mutation = false) {
  const componentId = String(req.params.componentId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(componentId)) {
    throw generateError("Invalid salary component id", 400);
  }

  const component = await SalaryComponent.findById(componentId);
  if (!component) {
    throw generateError("Salary component not found", 404);
  }

  const resolved = await resolvePayrollCompany(req, component.company, mutation);
  if (String(component.company) !== resolved.companyId) {
    throw generateError("Salary component not found", 404);
  }
  return { component, ...resolved };
}

export const listSalaryComponentsService = async (req: any, res: Response, next: NextFunction) => {
  try {
    ensurePayrollViewer(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query.companyId);
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "20"), 10) || 20));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "active").trim().toLowerCase();
    const category = String(req.query.category || "").trim().toLowerCase();

    if (!["active", "archived", "all"].includes(status)) {
      throw generateError("Invalid component status filter", 422);
    }
    if (category && !SALARY_COMPONENT_CATEGORIES.includes(category as SalaryComponentCategory)) {
      throw generateError("Invalid salary component category filter", 422);
    }

    const query: Record<string, unknown> = { company: companyObjectId };
    if (status !== "all") query.status = status;
    if (category) query.category = category;
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: regex }, { code: regex }, { description: regex }];
    }

    const [items, total] = await Promise.all([
      SalaryComponent.find(query)
        .sort({ displayOrder: 1, name: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SalaryComponent.countDocuments(query),
    ]);

    return res.status(200).send({
      status: "success",
      data: items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

export const createSalaryComponentService = async (req: any, res: Response, next: NextFunction) => {
  try {
    ensurePayrollConfigurationManager(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.body?.companyId, true);
    const actorId = getPayrollActorId(req);
    const payload = normalizeSalaryComponentPayload(req.body);
    validateSalaryComponentPayload(payload);

    const session = await mongoose.startSession();
    let component: any;
    try {
      await session.withTransaction(async () => {
        const duplicate = await SalaryComponent.findOne({ company: companyObjectId, code: payload.code })
          .session(session)
          .lean();
        if (duplicate) {
          throw generateError("A salary component with this code already exists", 409);
        }

        [component] = await SalaryComponent.create(
          [{ company: companyObjectId, ...payload, createdBy: actorId, updatedBy: actorId }],
          { session }
        );
        await writePayrollAudit(
          {
            company: companyObjectId,
            entityType: "salary_component",
            entityId: component._id,
            action: "created",
            actor: actorId,
            details: { after: componentSnapshot(component) },
          },
          session
        );
      });
    } finally {
      await session.endSession();
    }

    return res.status(201).send({ status: "success", data: component, message: "Salary component created" });
  } catch (error: any) {
    if (error?.code === 11000) {
      return next(generateError("A salary component with this code already exists", 409));
    }
    next(error);
  }
};

export const updateSalaryComponentService = async (req: any, res: Response, next: NextFunction) => {
  try {
    ensurePayrollConfigurationManager(req);
    const { component, companyObjectId } = await getScopedComponent(req, true);
    if (component.status === "archived") {
      throw generateError("Restore this component before editing it", 409);
    }

    const actorId = getPayrollActorId(req);
    const before = componentSnapshot(component);
    const payload = normalizeSalaryComponentPayload({
      ...component.toObject(),
      ...req.body,
      code: component.code,
      category: component.category,
    });
    validateSalaryComponentPayload(payload);

    component.name = payload.name;
    component.description = payload.description;
    component.taxable = payload.taxable;
    component.prorateOnUnpaidDays = payload.prorateOnUnpaidDays;
    component.displayOrder = payload.displayOrder;
    component.updatedBy = actorId;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await component.save({ session });
        await writePayrollAudit(
          {
            company: companyObjectId,
            entityType: "salary_component",
            entityId: component._id,
            action: "updated",
            actor: actorId,
            details: { before, after: componentSnapshot(component) },
          },
          session
        );
      });
    } finally {
      await session.endSession();
    }

    return res.status(200).send({ status: "success", data: component, message: "Salary component updated" });
  } catch (error) {
    next(error);
  }
};

export const archiveSalaryComponentService = async (req: any, res: Response, next: NextFunction) => {
  try {
    ensurePayrollConfigurationManager(req);
    const { component, companyObjectId } = await getScopedComponent(req, true);
    if (component.status === "archived") {
      return res.status(200).send({ status: "success", data: component, message: "Salary component is already archived" });
    }

    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 3 || reason.length > 500) {
      throw generateError("Archive reason must be between 3 and 500 characters", 422);
    }
    const actorId = getPayrollActorId(req);
    const before = componentSnapshot(component);
    component.status = "archived";
    component.archivedAt = new Date();
    component.archivedBy = actorId;
    component.archiveReason = reason;
    component.updatedBy = actorId;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await component.save({ session });
        await writePayrollAudit(
          {
            company: companyObjectId,
            entityType: "salary_component",
            entityId: component._id,
            action: "archived",
            actor: actorId,
            reason,
            details: { before, after: componentSnapshot(component) },
          },
          session
        );
      });
    } finally {
      await session.endSession();
    }

    return res.status(200).send({ status: "success", data: component, message: "Salary component archived" });
  } catch (error) {
    next(error);
  }
};

export const restoreSalaryComponentService = async (req: any, res: Response, next: NextFunction) => {
  try {
    ensurePayrollConfigurationManager(req);
    const { component, companyObjectId } = await getScopedComponent(req, true);
    if (component.status === "active") {
      return res.status(200).send({ status: "success", data: component, message: "Salary component is already active" });
    }

    const actorId = getPayrollActorId(req);
    const before = componentSnapshot(component);
    component.status = "active";
    component.archivedAt = null;
    component.archivedBy = null;
    component.archiveReason = undefined;
    component.updatedBy = actorId;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await component.save({ session });
        await writePayrollAudit(
          {
            company: companyObjectId,
            entityType: "salary_component",
            entityId: component._id,
            action: "restored",
            actor: actorId,
            details: { before, after: componentSnapshot(component) },
          },
          session
        );
      });
    } finally {
      await session.endSession();
    }

    return res.status(200).send({ status: "success", data: component, message: "Salary component restored" });
  } catch (error) {
    next(error);
  }
};

export const listPayrollAuditLogsService = async (req: any, res: Response, next: NextFunction) => {
  try {
    ensurePayrollViewer(req);
    const { companyObjectId } = await resolvePayrollCompany(req, req.query.companyId);
    const entityId = String(req.query.entityId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(entityId)) {
      throw generateError("Valid entityId is required", 422);
    }
    const entityType = String(req.query.entityType || "salary_component").trim();
    if (!PAYROLL_AUDIT_ENTITY_TYPES.includes(entityType as any)) {
      throw generateError("Invalid payroll audit entity type", 422);
    }

    const data = await PayrollAuditLog.find({
      company: companyObjectId,
      entityType,
      entityId: new mongoose.Types.ObjectId(entityId),
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("actor", "name username employeeCode")
      .lean();

    return res.status(200).send({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

