export const DEFAULT_BUSINESS_HOURS_NOTICE = Object.freeze({
  noticeText: "",
  noticeEnabled: false,
});

export function normalizeBusinessHoursNotice(value) {
  return {
    noticeText: typeof value?.noticeText === "string" ? value.noticeText.replace(/\r\n?/g, "\n").trim() : "",
    noticeEnabled: value?.noticeEnabled === true,
  };
}

export function withBusinessHoursNotice(settings) {
  return Object.freeze({ ...settings, ...normalizeBusinessHoursNotice(settings) });
}
