
import express from "express";
import authenticate from "../../modules/config/authenticate";
import { createOrUpdateMasterData , getMasterData, updateMasterCategory} from "../../services/masters/masters.service";

const masterRouting = express.Router();
masterRouting.put("/", authenticate, createOrUpdateMasterData);
masterRouting.put("/:category", authenticate, updateMasterCategory);
masterRouting.post("/", authenticate, getMasterData);

export default masterRouting;