
import express from "express";
import authenticate from "../../modules/config/authenticate";
import { createOrUpdateMasterData , getMasterData} from "../../services/masters/masters.service";

const masterRouting = express.Router();
masterRouting.put("/", authenticate, createOrUpdateMasterData);
masterRouting.post("/", authenticate, getMasterData);

export default masterRouting;