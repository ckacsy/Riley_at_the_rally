'use strict';

const RESERVED_USERNAMES = new Set([
  'admin', 'root', 'support', 'moderator', 'system', 'staff', 'official',
  'help', 'info', 'contact', 'security', 'abuse', 'postmaster', 'hostmaster',
  'noreply', 'no-reply', 'riley', 'torqon',
]);

const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000',
  'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'letmein1',
  'welcome1', 'monkey123', 'dragon12', 'master12', 'abc12345',
  'superman', 'batman123', 'trustno1', 'login123',
]);

// Allow letters, digits, spaces, hyphens, apostrophes, dots (Unicode-aware)
const DISPLAY_NAME_RE = /^[\p{L}\p{N} \-'.]+$/u;

// Username: starts and ends with letter/digit; middle may have _ - .
const USERNAME_RE = /^[\p{L}\p{N}]([\p{L}\p{N}_\-.]*[\p{L}\p{N}])?$/u;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * NFKC-normalise a string, strip zero-width / invisible chars, trim whitespace.
 * Removed ranges: C0/DEL controls (0000-001F, 007F), soft hyphen (00AD),
 * zero-width chars (200B-200D), line/paragraph separators (2028-2029), BOM (FEFF).
 */
function normalizeText(str) {
  return String(str)
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F\u00AD\u200B-\u200D\u2028\u2029\uFEFF]/g, '')
    .trim();
}

function validateDisplayName(name) {
  if (typeof name !== 'string') return 'Отображаемое имя обязательно';
  const trimmed = normalizeText(name);
  if (!trimmed) return 'Отображаемое имя не может состоять только из пробелов';
  if (trimmed.length < 2) return 'Отображаемое имя: минимум 2 символа';
  if (trimmed.length > 100) return 'Отображаемое имя: максимум 100 символов';
  if (!DISPLAY_NAME_RE.test(trimmed)) {
    return 'Отображаемое имя содержит недопустимые символы (разрешены буквы, цифры, пробелы, дефисы, апострофы, точки)';
  }
  return null;
}

function validateUsername(username) {
  if (typeof username !== 'string') return 'Имя пользователя обязательно';
  const trimmed = normalizeText(username);
  if (!trimmed) return 'Имя пользователя не может быть пустым';
  if (trimmed.length < 3) return 'Имя пользователя: минимум 3 символа';
  if (trimmed.length > 30) return 'Имя пользователя: максимум 30 символов';
  if (!USERNAME_RE.test(trimmed)) {
    return 'Имя пользователя может содержать буквы, цифры, _, - и . (не в начале/конце)';
  }
  if (RESERVED_USERNAMES.has(trimmed.toLowerCase())) {
    return 'Это имя пользователя зарезервировано';
  }
  return null;
}

function validateEmail(email) {
  if (typeof email !== 'string') return 'Email обязателен';
  const trimmed = email.trim();
  if (!trimmed) return 'Email обязателен';
  if (!EMAIL_RE.test(trimmed)) return 'Некорректный формат email';
  if (trimmed.length > 254) return 'Email слишком длинный';
  return null;
}

/**
 * @param {string} password
 * @param {string|undefined} confirmPassword  – pass undefined to skip match check
 */
function validatePassword(password, confirmPassword) {
  if (typeof password !== 'string' || password.length === 0) return 'Пароль обязателен';
  if (password.length < 8) return 'Пароль: минимум 8 символов';
  if (password.length > 128) return 'Пароль: максимум 128 символов';
  if (!/[A-Z]/.test(password)) return 'Пароль должен содержать хотя бы одну заглавную букву';
  if (!/[a-z]/.test(password)) return 'Пароль должен содержать хотя бы одну строчную букву';
  if (!/[0-9]/.test(password)) return 'Пароль должен содержать хотя бы одну цифру';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Пароль должен содержать хотя бы один специальный символ';
  if (WEAK_PASSWORDS.has(password.toLowerCase())) return 'Пароль слишком простой. Выберите более надёжный';
  if (confirmPassword !== undefined && confirmPassword !== null && password !== confirmPassword) {
    return 'Пароли не совпадают';
  }
  return null;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function normalizeUsername(username) {
  return normalizeText(username).toLowerCase();
}

/**
 * Validate that a value is a positive integer (>= 1).
 * @param {unknown} val
 * @param {string} fieldName - used in error message
 * @returns {string|null} error message or null
 */
function validatePositiveInt(val, fieldName) {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1) {
    return `${fieldName} должен быть положительным целым числом`;
  }
  return null;
}

/**
 * Validate YYYY-MM-DD date format.
 * @param {string} date
 * @param {string} fieldName
 * @returns {string|null} error message or null
 */
function validateDateParam(date, fieldName) {
  if (typeof date !== 'string') return `${fieldName} должен быть строкой формата ГГГГ-ММ-ДД`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${fieldName}: неверный формат даты (используйте ГГГГ-ММ-ДД)`;
  return null;
}

module.exports = {
  validateDisplayName,
  validateUsername,
  validateEmail,
  validatePassword,
  normalizeEmail,
  normalizeUsername,
  normalizeText,
  validatePositiveInt,
  validateDateParam,
  RESERVED_USERNAMES,
};
