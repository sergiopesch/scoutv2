import express from "express";
import { createScoutRuntime } from "./src/server/index.js";

const app = express();
const runtime = createScoutRuntime();
app.use(runtime.app);

export default app;
