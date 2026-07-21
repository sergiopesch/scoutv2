import express from "express";
import { createScoutRuntime } from "./src/server/index.js";

const runtime = createScoutRuntime();
const app: ReturnType<typeof express> = runtime.app;

export default app;
