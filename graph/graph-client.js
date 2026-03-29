#!/usr/bin/env node
/**
 * 🦀📊 HermitCrab Graph Client — Microsoft Graph API operations
 * 
 * Provides high-level wrappers for common Graph API calls.
 * All methods auto-handle token refresh.
 * 
 * Usage:
 *   const graph = require('./graph-client');
 *   
 *   // Calendar
 *   const events = await graph.getUpcomingEvents(7);
 *   
 *   // Files
 *   const files = await graph.listOneDriveFiles('/Documents');
 *   
 *   // Users
 *   const user = await graph.getUser('user@apexlearn.org');
 */

const https = require("https");
const { getAccessToken } = require("./auth");

// ═══════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════
function graphRequest(method, endpoint, body = null) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();
      const url = new URL(`https://graph.microsoft.com/v1.0${endpoint}`);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, (res) => {
        let chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          if (res.statusCode === 204) {
            return resolve({ ok: true, status: 204, data: null });
          }
          try {
            const data = JSON.parse(raw);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, status: res.statusCode, data });
            } else {
              resolve({
                ok: false,
                status: res.statusCode,
                error: data.error?.message || JSON.stringify(data),
                data,
              });
            }
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, error: raw });
          }
        });
      });
      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

const get = (endpoint) => graphRequest("GET", endpoint);
const post = (endpoint, body) => graphRequest("POST", endpoint, body);
const patch = (endpoint, body) => graphRequest("PATCH", endpoint, body);
const del = (endpoint) => graphRequest("DELETE", endpoint);

// ═══════════════════════════════════════════
// USER / PROFILE
// ═══════════════════════════════════════════

/** Get current user's profile */
async function getMe() {
  return get("/me");
}

/** Get a user by email or ID */
async function getUser(userIdOrEmail) {
  return get(`/users/${encodeURIComponent(userIdOrEmail)}`);
}

/** List users in the organization */
async function listUsers(top = 50) {
  return get(`/users?$top=${top}&$select=id,displayName,mail,userPrincipalName,jobTitle`);
}

/** Search users by display name */
async function searchUsers(query, top = 10) {
  return get(`/users?$filter=startswith(displayName,'${encodeURIComponent(query)}')&$top=${top}&$select=id,displayName,mail,userPrincipalName`);
}

// ═══════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════

/** Get upcoming events for the next N days */
async function getUpcomingEvents(days = 7, userEmail = null) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const startISO = now.toISOString();
  const endISO = end.toISOString();
  const base = userEmail ? `/users/${encodeURIComponent(userEmail)}` : "/me";
  return get(
    `${base}/calendarView?startDateTime=${startISO}&endDateTime=${endISO}&$orderby=start/dateTime&$select=subject,start,end,location,organizer,isOnlineMeeting,onlineMeetingUrl,bodyPreview&$top=50`
  );
}

/** Get today's events */
async function getTodaysEvents(userEmail = null) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const base = userEmail ? `/users/${encodeURIComponent(userEmail)}` : "/me";
  return get(
    `${base}/calendarView?startDateTime=${startOfDay.toISOString()}&endDateTime=${endOfDay.toISOString()}&$orderby=start/dateTime&$select=subject,start,end,location,organizer,isOnlineMeeting,onlineMeetingUrl,bodyPreview`
  );
}

/** Create a calendar event */
async function createEvent(event, userEmail = null) {
  const base = userEmail ? `/users/${encodeURIComponent(userEmail)}` : "/me";
  return post(`${base}/events`, event);
}

/** Find free/busy times for scheduling */
async function getSchedule(emails, startTime, endTime) {
  return post("/me/calendar/getSchedule", {
    schedules: emails,
    startTime: { dateTime: startTime, timeZone: "Eastern Standard Time" },
    endTime: { dateTime: endTime, timeZone: "Eastern Standard Time" },
    availabilityViewInterval: 30,
  });
}

// ═══════════════════════════════════════════
// ONEDRIVE / FILES
// ═══════════════════════════════════════════

/** List files in a OneDrive folder */
async function listOneDriveFiles(folderPath = "/", top = 50) {
  const cleanPath = folderPath === "/" ? "root" : `root:${folderPath}:`;
  return get(`/me/drive/${cleanPath}/children?$top=${top}&$select=id,name,size,lastModifiedDateTime,file,folder,webUrl`);
}

/** Get file content (text-based files) */
async function getFileContent(itemId) {
  return get(`/me/drive/items/${itemId}/content`);
}

/** Search OneDrive for files */
async function searchFiles(query, top = 20) {
  return get(`/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${top}&$select=id,name,size,lastModifiedDateTime,webUrl,parentReference`);
}

/** Upload a file to OneDrive (small files < 4MB) */
async function uploadFile(folderPath, fileName, content) {
  const token = await getAccessToken();
  return new Promise((resolve, reject) => {
    const encodedPath = encodeURIComponent(`${folderPath}/${fileName}`).replace(/%2F/g, "/");
    const url = new URL(`https://graph.microsoft.com/v1.0/me/drive/root:${encodedPath}:/content`);
    const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": data.length,
      },
    };
    const req = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          resolve({ ok: res.statusCode < 300, status: res.statusCode, data: result });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, error: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════
// SHAREPOINT
// ═══════════════════════════════════════════

/** List SharePoint sites */
async function listSites(query = "") {
  if (query) {
    return get(`/sites?search=${encodeURIComponent(query)}&$select=id,name,displayName,webUrl`);
  }
  return get("/sites?$select=id,name,displayName,webUrl&$top=50");
}

/** Get a SharePoint site by hostname and path */
async function getSite(hostname, sitePath) {
  return get(`/sites/${hostname}:${sitePath}`);
}

/** List document libraries in a site */
async function listDrives(siteId) {
  return get(`/sites/${siteId}/drives?$select=id,name,driveType,webUrl`);
}

/** List files in a SharePoint library folder */
async function listSharePointFiles(siteId, driveId, folderPath = "/", top = 50) {
  const cleanPath = folderPath === "/" ? "root" : `root:${folderPath}:`;
  return get(`/sites/${siteId}/drives/${driveId}/${cleanPath}/children?$top=${top}&$select=id,name,size,lastModifiedDateTime,file,folder,webUrl`);
}

// ═══════════════════════════════════════════
// PLANNER / TASKS
// ═══════════════════════════════════════════

/** List my planner tasks */
async function getMyTasks(top = 20) {
  return get(`/me/planner/tasks?$top=${top}`);
}

/** Create a planner task */
async function createTask(planId, bucketId, title, assignments = {}) {
  return post("/planner/tasks", {
    planId,
    bucketId,
    title,
    assignments,
  });
}

/** List plans for a group */
async function listPlans(groupId) {
  return get(`/groups/${groupId}/planner/plans`);
}

// ═══════════════════════════════════════════
// MAIL
// ═══════════════════════════════════════════

/** Get recent emails */
async function getRecentMail(top = 10) {
  return get(`/me/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`);
}

/** Send an email */
async function sendMail(to, subject, body, contentType = "Text") {
  return post("/me/sendMail", {
    message: {
      subject,
      body: { contentType, content: body },
      toRecipients: (Array.isArray(to) ? to : [to]).map((addr) => ({
        emailAddress: { address: addr },
      })),
    },
  });
}

// ═══════════════════════════════════════════
// TEAMS / CHAT
// ═══════════════════════════════════════════

/** List my Teams chats */
async function listChats(top = 20) {
  return get(`/me/chats?$top=${top}&$select=id,topic,chatType,lastUpdatedDateTime`);
}

/** Get messages from a chat */
async function getChatMessages(chatId, top = 20) {
  return get(`/chats/${chatId}/messages?$top=${top}`);
}

/** Send a message to a Teams chat */
async function sendChatMessage(chatId, content, contentType = "text") {
  return post(`/chats/${chatId}/messages`, {
    body: { contentType, content },
  });
}

// ═══════════════════════════════════════════
// PRESENCE
// ═══════════════════════════════════════════

/** Get presence status for users */
async function getPresence(userIds) {
  return post("/communications/getPresencesByUserId", {
    ids: Array.isArray(userIds) ? userIds : [userIds],
  });
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════
module.exports = {
  // Raw request
  graphRequest,
  get,
  post,
  patch,
  del,

  // Users
  getMe,
  getUser,
  listUsers,
  searchUsers,

  // Calendar
  getUpcomingEvents,
  getTodaysEvents,
  createEvent,
  getSchedule,

  // OneDrive
  listOneDriveFiles,
  getFileContent,
  searchFiles,
  uploadFile,

  // SharePoint
  listSites,
  getSite,
  listDrives,
  listSharePointFiles,

  // Planner
  getMyTasks,
  createTask,
  listPlans,

  // Mail
  getRecentMail,
  sendMail,

  // Teams
  listChats,
  getChatMessages,
  sendChatMessage,

  // Presence
  getPresence,
};
