import express from "express";
import authenticate from "../modules/config/authenticate";
import {
  createOfficeLocationService,
  deleteOfficeLocationService,
  getOfficeLocationsService,
  updateOfficeLocationService,
} from "../services/officeLocation/officeLocation.service";

const officeLocationRouting = express.Router();

officeLocationRouting.post("/create", authenticate, createOfficeLocationService);
officeLocationRouting.put("/update/:id", authenticate, updateOfficeLocationService);
officeLocationRouting.delete("/delete/:id", authenticate, deleteOfficeLocationService);
officeLocationRouting.get("/list", authenticate, getOfficeLocationsService);

export default officeLocationRouting;
