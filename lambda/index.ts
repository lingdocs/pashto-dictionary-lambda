import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
// wish we could tree shake this!
import { google } from "googleapis";
import { sheets } from "@googleapis/sheets";
import { getEntriesFromSheet } from "@lingdocs/auth-shared";
import {
  checkForErrors,
  dictionaryFilename,
  dictionaryInfoFilename,
  makeDictionaryObject,
  makeSitemap,
} from "../lib/publishing-helpers";
import { uploader } from "../lib/uploader";
import { S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "../lib/env-helper";
import { cors } from "hono/cors";
// import { getWordList } from "../lib/word-list-maker";
// const allWordsJsonFilename = "all-words-dictionary2.json";

const app = new Hono();

app.use(
  cors({ origin: ["https://dictionary.lingdocs.com"], credentials: true }),
);
app.get("/publish", async (c) => {
  // check if caller is authorized as lingdocs admin
  // might be nicer to abstract this into some middleware
  const cookie = c.req.header("cookie");
  if (!cookie) {
    c.status(401);
    return c.json({
      ok: false,
      error: "unauthorized",
    });
  }
  console.log("Will fetch user for auth");
  // TODO: use getUser from auth-shared
  const r = await fetch("https://account.lingdocs.com/api/user", {
    headers: { Cookie: cookie },
  });
  const { ok, user } = await r.json();
  if (ok !== true || typeof user !== "object" || !user.admin) {
    return c.json({
      ok: false,
      error: "unauthorized",
    });
  }
  console.log({ user });
  const vars = getEnv(c);
  console.log({ vars });
  const auth = new google.auth.GoogleAuth({
    credentials: {
      private_key: vars.LINGDOCS_SERVICE_ACCOUNT_KEY,
      client_email: vars.LINGDOCS_SERVICE_ACCOUNT_EMAIL,
    },
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });
  const { spreadsheets } = sheets({
    version: "v4",
    auth,
  });
  const entries = await getEntriesFromSheet({
    spreadsheets,
    spreadsheetId: vars.LINGDOCS_DICTIONARY_SPREADSHEET,
  });
  console.log("Got entries", entries[0]);
  const errors = checkForErrors(entries);
  if (errors.length) {
    return c.json({
      ok: false,
      errors,
    });
  }
  const dictionary = makeDictionaryObject(entries);
  const sitemap = makeSitemap(dictionary);
  // const wordListRes = getWordList(dictionary.entries);
  // if (!wordListRes.ok) {
  //   return c.json({
  //     ok: false,
  //     error: "error(s) in creating inflections",
  //     errors: wordListRes.errors,
  //   });
  // }
  // const wordList: T.AllWordsWithInflections = {
  //   info: dictionary.info,
  //   words: wordListRes.wordlist,
  // };
  // got dictionary, now upload it to storage
  const s3Client = new S3Client({
    region: "auto",
    endpoint: vars.DICT_R2_ENDPOINT,
    credentials: {
      accessKeyId: vars.DICT_R2_KEY_ID,
      secretAccessKey: vars.DICT_R2_KEY_SECRET,
    },
  });
  const upload = uploader(vars.DICT_R2_BUCKET, s3Client);
  const uploadResult = await Promise.all([
    upload(JSON.stringify(dictionary), `${dictionaryFilename}.json`),
    upload(JSON.stringify(dictionary.info), `${dictionaryInfoFilename}.json`),
    upload(sitemap, `sitemap2.xml`),
    // upload(JSON.stringify(wordList), allWordsJsonFilename),
  ]);
  if (uploadResult.some((res) => res.output.$metadata.httpStatusCode !== 200)) {
    return c.json({
      ok: false,
      error: "error uploading file(s)",
      uploadResult,
    });
  }
  return c.json({
    ok: true,
    info: dictionary.info,
  });
});

export const handler = handle(app);
