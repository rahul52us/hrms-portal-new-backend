import userRouting from "./User";
import adminUsersRouting from "./adminUsers.routing";
import companyOrganisation from "./company.routing";
import contactRouting from "./contact.routing";
import dashboardRouting from "./dashboard/dashboard.routing";
import fileRouting from "./file.routing";
import masterRouting from "./masters/master.routing";
import notificationRouting from './notification/notification.routing';
import testimonialRouting from "./testimonial";
import tokenRouting from "./token/token.routing";
import UserRouting from "./users.routing";
import departmentRouting from "./departments.routing";
import officeLocationRouting from "./officeLocations.routing";
import organizationRouting from "./organization.routing";
import workforcePoliciesRouting from "./workforcePolicies.routing";
import leaveRouting from "./leave.routing";
import approvalWorkflowsRouting from "./approvalWorkflows.routing";
import attendanceRouting from "./attendance.routing";
import remoteWorkRouting from "./remoteWork.routing";
import compOffRouting from "./compOff.routing";
import calendarRouting from "./calendar.routing";
import payrollRouting from "./payroll.routing";
import projectsRouting from "./projects.routing";

const importRoutings = (app: any) => {
  app.use("/api/auth", userRouting);
  app.use('/api/contact',contactRouting)
  app.use('/api/notification',notificationRouting)
  app.use('/api/notifications',notificationRouting)
  app.use('/api/file',fileRouting)
  app.use("/api/admin/users", adminUsersRouting);
  app.use("/api/admin/organization", organizationRouting);
  app.use('/api/dashboard',dashboardRouting)
  app.use("/api/company", companyOrganisation);
  app.use("/api/User", UserRouting);
  app.use('/api/token',tokenRouting);
  app.use("/api/testimonial", testimonialRouting);
  app.use('/api/masters',masterRouting)
  app.use('/api/department', departmentRouting);
  app.use('/api/locations', officeLocationRouting);
  app.use('/api/workforce-policies', workforcePoliciesRouting);
  app.use('/api/approval-workflows', approvalWorkflowsRouting);
  app.use('/api/leave', leaveRouting);
  app.use('/api/attendance', attendanceRouting);
  app.use('/api/remote-work', remoteWorkRouting);
  app.use('/api/comp-off', compOffRouting);
  app.use('/api/calendar', calendarRouting);
  app.use('/api/payroll', payrollRouting);
  app.use('/api/projects', projectsRouting);
};

export default importRoutings;
