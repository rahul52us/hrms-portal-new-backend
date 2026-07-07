// utils/reports/downloadReport.ts (or wherever you have it)

import ExcelJS from "exceljs";
import UserModel from "../../schemas/User/User";
import appointmentsSchema from "../../schemas/appointments/appointments.schema";
import recallAppointmentSchema from "../../schemas/recall-appointment/recallAppointment.schema";
import mongoose from "mongoose";


export async function downloadReport(data: any) {
  try {
    const { reportType, filters = {} } = data;

    const validTypes = ["patient", "doctor", "appointment", "recall", "staff"];
    if (!reportType || !validTypes.includes(reportType)) {
      return {
        status: "error",
        message: "Invalid report type",
        data: null,
        statusCode: 400,
      };
    }

    const workbook = new ExcelJS.Workbook();
    const sheetName = `${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Report`;
    const worksheet = workbook.addWorksheet(sheetName);

    let columns: any[] = [];
    let rows: any[] = [];

    // Build date filter
    const dateFilter: any = {};
    if (filters.fromDate) {
      dateFilter.$gte = new Date(filters.fromDate);
    }
    if (filters.toDate) {
      const toDate = new Date(filters.toDate);
      toDate.setHours(23, 59, 59, 999);
      dateFilter.$lte = toDate;
    }

    switch (reportType) {
      // =====================================
      // PATIENT REPORT
      // =====================================
      case "patient": {
        let matchStage: any = { userType: "patient" };

        if (Object.keys(dateFilter).length > 0) {
          matchStage.createdAt = dateFilter;
        }

        if (filters.category === "withAppointments") {
          const patientsWithAppts = await appointmentsSchema.distinct("patient", {});
          matchStage._id = { $in: patientsWithAppts };
        } else if (filters.category === "withRecalls") {
          const patientsWithRecalls = await recallAppointmentSchema.distinct("patient", {});
          matchStage._id = { $in: patientsWithRecalls };
        }

        columns = [
          { header: "Code", key: "code", width: 15 },
          { header: "Name", key: "name", width: 25 },
          { header: "Title", key: "title", width: 10 },
          { header: "Mobile", key: "mobileNumber", width: 18 },
          { header: "Email", key: "primaryEmail", width: 30 },
          { header: "Gender", key: "gender", width: 12 },
          { header: "DOB", key: "dob", width: 15 },
          { header: "Age", key: "age", width: 10 },
          { header: "Address", key: "residentialAddress", width: 40 },
          { header: "Languages", key: "languages", width: 25 },
          { header: "Active", key: "is_active", width: 10 },
          { header: "Registered On", key: "registeredOn", width: 20 },
        ];

        const aggregationResult = await UserModel.aggregate([
          { $match: matchStage },
          {
            $lookup: {
              from: "profiledetails",
              localField: "profile_details",
              foreignField: "_id",
              as: "profile_details_data",
            },
          },
          { $unwind: { path: "$profile_details_data", preserveNullAndEmptyArrays: true } },
          { $sort: { createdAt: -1 } },
          {
            $project: {
              code: 1,
              name: 1,
              mobileNumber: 1,
              is_active: 1,
              createdAt: 1,
              profile: "$profile_details_data.personalInfo",
            },
          },
        ]);

        rows = aggregationResult.map((user: any) => {
          const profile = user.profile || {};
          let age = "-";
          if (profile.dob) {
            const birthDate = new Date(profile.dob);
            const today = new Date();
            age = String(today.getFullYear() - birthDate.getFullYear());
            const m = today.getMonth() - birthDate.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
              age = String(parseInt(age) - 1);
            }
          }

          return {
            code: user.code || "-",
            name: user.name || "-",
            title: profile.title || "-",
            mobileNumber: user.mobileNumber || "-",
            primaryEmail: profile.emails?.find((e: any) => e.primary)?.email || "-",
            gender:
              profile.gender === 1
                ? "Male"
                : profile.gender === 2
                  ? "Female"
                  : profile.gender === 4
                    ? "Prefer Not to Say"
                    : "Other",
            dob: profile.dob ? new Date(profile.dob).toLocaleDateString() : "-",
            age,
            residentialAddress: profile.addresses?.residential || "-",
            languages: profile.languages?.join(", ") || "-",
            is_active: user.is_active ? "Yes" : "No",
            registeredOn: user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-",
          };
        });
        break;
      }

      // =====================================
      // DOCTOR REPORT
      // =====================================
      case "doctor": {
        let matchStage: any = { userType: "doctor" };

        if (Object.keys(dateFilter).length > 0) {
          matchStage.createdAt = dateFilter;
        }

        // If filtering by patient (patients treated by this doctor)
        if (filters.patientId) {
          const appointments = await appointmentsSchema.distinct("doctor", {
            patient: filters.patientId,
          });
          matchStage._id = { $in: appointments };
        }

        columns = [
          { header: "Code", key: "code", width: 15 },
          { header: "Title", key: "title", width: 10 },
          { header: "Name", key: "name", width: 25 },
          { header: "Mobile", key: "mobileNumber", width: 18 },
          { header: "Email", key: "primaryEmail", width: 30 },
          { header: "Gender", key: "gender", width: 12 },
          { header: "DOB", key: "dob", width: 15 },
          { header: "Specialty", key: "designation", width: 35 },
          { header: "Languages", key: "languages", width: 25 },
          { header: "Office Address", key: "officeAddress", width: 40 },
          { header: "Active", key: "is_active", width: 10 },
          { header: "Registered On", key: "registeredOn", width: 20 },
        ];

        const aggregationResult = await UserModel.aggregate([
          { $match: matchStage },
          {
            $lookup: {
              from: "profiledetails",
              localField: "profile_details",
              foreignField: "_id",
              as: "profile_details_data",
            },
          },
          { $unwind: { path: "$profile_details_data", preserveNullAndEmptyArrays: true } },
          { $sort: { createdAt: -1 } },
          {
            $project: {
              code: 1,
              name: 1,
              mobileNumber: 1,
              is_active: 1,
              createdAt: 1,
              designation: 1,
              profile: "$profile_details_data.personalInfo",
            },
          },
        ]);

        rows = aggregationResult.map((user: any) => {
          const profile = user.profile || {};
          return {
            code: user.code || "-",
            title: profile.title || "-",
            name: user.name || "-",
            mobileNumber: user.mobileNumber || "-",
            primaryEmail: profile.emails?.find((e: any) => e.primary)?.email || "-",
            gender:
              profile.gender === 1
                ? "Male"
                : profile.gender === 2
                  ? "Female"
                  : profile.gender === 4
                    ? "Prefer Not to Say"
                    : "Other",
            dob: profile.dob ? new Date(profile.dob).toLocaleDateString() : "-",
            designation: user.designation?.join(", ") || "-",
            languages: profile.languages?.join(", ") || "-",
            officeAddress: profile.addresses?.office || "-",
            is_active: user.is_active ? "Yes" : "No",
            registeredOn: user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-",
          };
        });
        break;
      }

      // =====================================
      // APPOINTMENT REPORT
      // =====================================
      case "appointment": {
  let matchStage: any = {};

  // Patient filter
  if (filters.patientId) {
    matchStage.patient = new mongoose.Types.ObjectId(filters.patientId);
  }

  // Doctor filter – matches if primaryDoctor OR in additionalDoctors
  if (filters.doctorId) {
    const doctorId = new mongoose.Types.ObjectId(filters.doctorId);
    matchStage.$or = [
      { primaryDoctor: doctorId },
      { additionalDoctors: doctorId }
    ];
  }

  // Status filter
  if (filters.status && filters.status !== "") {
    if (filters.status === "upcoming") {
      // Upcoming: appointmentDate >= today AND status is scheduled or arrived or in-progress
      matchStage.appointmentDate = { $gte: new Date() };
      matchStage.status = { $in: ["scheduled", "arrived", "in-progress"] };
    } else {
      // Direct match: completed, cancelled, no-show, shift, etc.
      matchStage.status = filters.status;
    }
  }

  // Date range filter on appointmentDate
  if (Object.keys(dateFilter).length > 0) {
    matchStage.appointmentDate = dateFilter;
  }

  // Always filter active appointments
  matchStage.isActive = true;

  columns = [
    { header: "Appointment ID", key: "appointmentId", width: 20 },
    { header: "Date", key: "date", width: 18 },
    { header: "Start Time", key: "startTime", width: 15 },
    { header: "End Time", key: "endTime", width: 15 },
    { header: "Patient Name", key: "patientName", width: 25 },
    { header: "Patient Mobile", key: "patientMobile", width: 18 },
    { header: "Primary Doctor", key: "primaryDoctorName", width: 25 },
    { header: "Additional Doctors", key: "additionalDoctorsNames", width: 35 },
    { header: "Status", key: "status", width: 15 },
    { header: "Mode", key: "mode", width: 12 },
    { header: "Title", key: "title", width: 30 },
    { header: "Description", key: "description", width: 50 },
  ];

  const appointments = await appointmentsSchema.aggregate([
    { $match: matchStage },
    {
      $lookup: {
        from: "users",
        localField: "patient",
        foreignField: "_id",
        as: "patientData",
      },
    },
    { $unwind: { path: "$patientData", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "primaryDoctor",
        foreignField: "_id",
        as: "primaryDoctorData",
      },
    },
    { $unwind: { path: "$primaryDoctorData", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "additionalDoctors",
        foreignField: "_id",
        as: "additionalDoctorsData",
      },
    },
    // Sort by latest appointment first
    { $sort: { appointmentDate: -1, startTime: -1 } },
    {
      $project: {
        appointmentId: "$_id",
        appointmentDate: 1,
        startTime: 1,
        endTime: 1,
        patientName: "$patientData.name",
        patientMobile: "$patientData.mobileNumber",
        primaryDoctorName: "$primaryDoctorData.name",
        additionalDoctorsNames: {
          $map: {
            input: "$additionalDoctorsData",
            as: "doc",
            in: "$$doc.name"
          }
        },
        status: 1,
        mode: 1,
        title: 1,
        description: 1,
      },
    },
  ]);

  rows = appointments.map((appt: any) => ({
    appointmentId: appt.appointmentId?.toString() || "-",
    date: appt.appointmentDate ? new Date(appt.appointmentDate).toLocaleDateString() : "-",
    startTime: appt.startTime || "-",
    endTime: appt.endTime || "-",
    patientName: appt.patientName || "Unknown Patient",
    patientMobile: appt.patientMobile || "-",
    primaryDoctorName: appt.primaryDoctorName || "Unknown Doctor",
    additionalDoctorsNames: appt.additionalDoctorsNames?.length > 0
      ? appt.additionalDoctorsNames.join(", ")
      : "-",
    status: appt.status
      ? appt.status.charAt(0).toUpperCase() + appt.status.slice(1).replace("-", " ")
      : "Unknown",
    mode: appt.mode ? appt.mode.charAt(0).toUpperCase() + appt.mode.slice(1) : "-",
    title: appt.title || "-",
    description: appt.description || "-",
  }));
  break;
}

      // =====================================
      // RECALL REPORT
      // =====================================
      case "recall": {
        let matchStage: any = {};

        if (filters.patientId) matchStage.patient = filters.patientId;

        if (filters.status && filters.status !== "") {
          matchStage.status = filters.status;
        }

        if (Object.keys(dateFilter).length > 0) {
          matchStage.recallDate = dateFilter;
        }

        columns = [
          { header: "Recall ID", key: "recallId", width: 20 },
          { header: "Recall Date", key: "recallDate", width: 18 },
          { header: "Patient Name", key: "patientName", width: 25 },
          { header: "Patient Mobile", key: "patientMobile", width: 18 },
          { header: "Reason", key: "reason", width: 40 },
          { header: "Status", key: "status", width: 15 },
          { header: "Notes", key: "notes", width: 50 },
        ];

        const recalls = await recallAppointmentSchema.aggregate([
          { $match: matchStage },
          {
            $lookup: {
              from: "users",
              localField: "patient",
              foreignField: "_id",
              as: "patientData",
            },
          },
          { $unwind: { path: "$patientData", preserveNullAndEmptyArrays: true } },
          { $sort: { recallDate: -1 } },
          {
            $project: {
              recallId: "$_id",
              recallDate: "$recallDate",
              patientName: "$patientData.name",
              patientMobile: "$patientData.mobileNumber",
              reason: 1,
              status: 1,
              notes: 1,
            },
          },
        ]);

        rows = recalls.map((recall: any) => ({
          recallId: recall.recallId.toString(),
          recallDate: recall.recallDate ? new Date(recall.recallDate).toLocaleDateString() : "-",
          patientName: recall.patientName || "-",
          patientMobile: recall.patientMobile || "-",
          reason: recall.reason || "-",
          status: recall.status ? recall.status.charAt(0).toUpperCase() + recall.status.slice(1) : "-",
          notes: recall.notes || "-",
        }));
        break;
      }

      // =====================================
      // STAFF REPORT (unchanged except role filter)
      // =====================================
      case "staff": {
        let matchStage: any = {
          userType: { $nin: ["patient", "doctor"] },
          role: { $in: ["admin", "user", "superadmin"] },
        };

        if (filters.role && filters.role !== "all") {
          matchStage.role = filters.role;
        }

        if (Object.keys(dateFilter).length > 0) {
          matchStage.createdAt = dateFilter;
        }

        columns = [
          { header: "Code", key: "code", width: 15 },
          { header: "Name", key: "name", width: 25 },
          { header: "Mobile", key: "mobileNumber", width: 18 },
          { header: "Username", key: "username", width: 20 },
          { header: "Role", key: "role", width: 15 },
          { header: "Designation", key: "designation", width: 30 },
          { header: "Active", key: "is_active", width: 10 },
          { header: "Joined On", key: "joinedOn", width: 20 },
        ];

        const aggregationResult = await UserModel.aggregate([
          { $match: matchStage },
          { $sort: { createdAt: -1 } },
          {
            $project: {
              code: 1,
              name: 1,
              mobileNumber: 1,
              username: 1,
              role: 1,
              designation: 1,
              is_active: 1,
              createdAt: 1,
            },
          },
        ]);

        rows = aggregationResult.map((user: any) => ({
          code: user.code || "-",
          name: user.name || "-",
          mobileNumber: user.mobileNumber || "-",
          username: user.username || "-",
          role: user.role || "-",
          designation: user.designation?.join(", ") || "-",
          is_active: user.is_active ? "Yes" : "No",
          joinedOn: user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "-",
        }));
        break;
      }
    }

    // Apply to worksheet
    worksheet.columns = columns;
    worksheet.addRows(rows);

    // Style header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E79" },
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };

    // Auto-adjust column widths
    worksheet.columns.forEach((col: any) => {
      const maxLength = Math.max(
        col.header?.length || 0,
        ...rows.map((row: any) => (row[col.key] || "").toString().length)
      );
      col.width = maxLength + 8;
    });

    const buffer : any = await workbook.xlsx.writeBuffer();
    const base64Excel = buffer.toString("base64");

    return {
      status: "success",
      message: "Report generated successfully",
      data: {
        fileName: `${reportType}-report-${new Date().toISOString().split("T")[0]}.xlsx`,
        fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileData: base64Excel,
      },
      statusCode: 200,
    };
  } catch (error: any) {
    console.error("Report Generation Error:", error);
    return {
      status: "error",
      message: error.message || "Failed to generate report",
      data: null,
      statusCode: 500,
    };
  }
}
