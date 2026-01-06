import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pkg from "pg";
import OpenAI from "openai";
import axios from "axios";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import fetch from "node-fetch";

dotenv.config({ override: true });

// ESM-vennlig __dirname / __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM;

// Init Resend
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;


const { Pool } = pkg;

const PORT = process.env.PORT || 4000;

