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
import StudentRouting from "./userTypes/student";
import UserRouting from "./users.routing";
import scormRouting from "./scorm.routing";
import managerRouting from "./manager.routing";
import courseDetailsRouting from "./course/course.routing";
import courseAccessRouting from "./courseAccess.routing";
import batchRouting from "./batch.routing";
import departmentRouting from "./departments.routing";
import officeLocationRouting from "./officeLocations.routing";
import certificateRouting from "./certificate.routing";

const importRoutings = (app: any) => {
  app.use("/api/auth", userRouting);
  app.use('/api/contact',contactRouting)
  app.use('/api/notification',notificationRouting)
  app.use('/api/notifications',notificationRouting)
  app.use('/api/file',fileRouting)
  app.use("/api/admin/users", adminUsersRouting);
  app.use('/api/dashboard',dashboardRouting)
  app.use("/api/company", companyOrganisation);
  app.use("/api/User", UserRouting);
  app.use('/api/token',tokenRouting);
  app.use("/api/testimonial", testimonialRouting);
  app.use("/api/student", StudentRouting);
  app.use('/api/masters',masterRouting)
  app.use("/api/scorm", scormRouting);
  app.use("/api/manager", managerRouting);
  app.use('/api/course', courseDetailsRouting);
  app.use('/api/certificates', certificateRouting);
  app.use('/api', courseAccessRouting);
  app.use('/api', batchRouting);
  app.use('/api/department', departmentRouting);
  app.use('/api/locations', officeLocationRouting);
};

export default importRoutings;
