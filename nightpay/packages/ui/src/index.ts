export { HOLD_MS, HoldButton } from './components/HoldButton';
export { BusyWord, Button } from './components/Button';
export { Card } from './components/Card';
export { AmountDisplay } from './components/AmountDisplay';
export { StatusPill } from './components/StatusPill';
export type { PaymentStatus } from './components/StatusPill';
export { Stage, StageMeta } from './components/Stage';
export { Input, Select } from './components/Input';
export { FormError } from './components/FormError';
export { Modal } from './components/Modal';
export { ThemeToggle } from './components/ThemeToggle';
export { Logo } from './components/Logo';
export { CartaIcon, CartaItemIcon, CARTA_ICON_PATHS } from './components/CartaIcon';
export { SectionChip } from './components/SectionChip';
export { formatEur } from './format';

// Colores de las secciones (Copas, Servicios…): los mismos que --np-sec-* de styles.css.
export {
  SECTION_BY_CODE,
  SECTION_FALLBACK_COLOR,
  SECTION_ON_COLOR,
  SECTION_TILE_COLORS,
  SECTIONS,
  sectionColor,
  sectionOf,
  sectionsChipText,
  sectionTileColor,
  sectionTileVar,
  sectionVar,
} from './lib/sections';
export type { Section, SectionCode, SectionKey } from './lib/sections';

// Apps del personal (operadora y TPV): resultado a pantalla completa, aviso de
// conexión, teclado de importe y cuenta atrás del QR, con su lógica pura.
export { PaymentOutcome } from './components/PaymentOutcome';
export { OutcomeHowCard } from './components/PaymentOutcome';
export type { OutcomeAction, OutcomeHow, PaymentOutcomeProps } from './components/PaymentOutcome';
export { ConnectionBanner } from './components/ConnectionBanner';
export { AmountKeypad } from './components/AmountKeypad';
export { QrCountdown } from './components/QrCountdown';
export { useDelayedFlag, useNow, useOnline, useWakeLock } from './hooks';
export { outcomeKindOf, OUTCOME_TITLE, clockTime } from './lib/outcome';
export type { OutcomeKind } from './lib/outcome';
export {
  agoLabel,
  awaitingServerExpiry,
  countdownPhase,
  effectiveStatus,
  ENDING_SECONDS,
  formatClock,
  isPreCobro,
  LOCAL_EXPIRY_GRACE_MS,
  qrDeadline,
  remainingFraction,
  secondsLeft,
} from './lib/countdown';
export type { CountdownPhase, QrDeadline } from './lib/countdown';
export {
  DEFAULT_KEYPAD_MAX_CENTS,
  KEYPAD_LAYOUT,
  keypadKeyFromKeyboard,
  keypadKeyLabel,
  pressKeypad,
} from './lib/amount-keypad';
export type { KeypadKey } from './lib/amount-keypad';
export { BANK_SLOW_AFTER_MS, classifyConnection, SERVER_DOWN_GRACE_MS } from './lib/connection';
export type { ConnectionDevice, ConnectionIssue, ConnectionIssueKind, ConnectionSignals } from './lib/connection';
export { createWakeLock, wakeLockFrom } from './lib/wake-lock';
export { BITCOIN_HOW_SUB, cardHow, cashHow, chargedBy, saldoHow } from './lib/outcome-how';
export type { CardHowInput, CashHowInput, SaldoHowInput } from './lib/outcome-how';
export { haptic, HAPTIC_BAD, HAPTIC_TAP_MS } from './lib/haptic';
export { pinFailed, shakeClass } from './lib/shake';
export { advanceStatus, isFinalStatus, isPolledPayment } from './lib/payment-status';
export { createPoller } from './lib/poller';
export type { PollOutcome, Poller, PollerOptions } from './lib/poller';
export {
  createPaymentLive,
  PAYMENT_POLL_LIVE_MS,
  PAYMENT_POLL_OFFLINE_MS,
  PAYMENT_POLL_TIMEOUT_MS,
  PAYMENT_RECONNECT_AFTER_SERVER_CLOSE_MS,
  PAYMENT_RECONNECT_MS,
} from './lib/payment-live';
export type { PaymentLive, PaymentLiveOptions, PaymentSocket } from './lib/payment-live';
export type { WakeLockController, WakeLockEnv, WakeLockLike, WakeLockSentinelLike } from './lib/wake-lock';

// Código QR sin dependencias (la consola y la app del personal): la matriz y su trazado SVG.
export { encodeQr, qrSvgPath } from './lib/qr';
export type { QrMatrix } from './lib/qr';

// Pantalla de fallo de las apps y el aviso al API (Grafito).
export { ErrorScreen } from './components/ErrorScreen';
export { reportClientError } from './lib/report-client-error';

// Instalar la web como app (pantalla completa): el aviso y los pasos del iPhone.
export { InstallHint, IosInstallSteps, useInstall } from './components/InstallHint';
export { installHintOffered, installPlatform, isAppleMobile, installSnoozed, snoozeInstall, INSTALL_SNOOZE_MS } from './lib/install';
export type { InstallPlatform } from './lib/install';

// El tutorial de cada pantalla: «?» y pasos sobre elementos con data-tour.
export { HelpButton, ScreenHelp, Tour, findTourTarget, useTour } from './components/Tour';
export type { TourProps, UseTour } from './components/Tour';
export {
  TOUR_VERSION,
  bubblePlacement,
  closeMarksSeen,
  hasSeenTour,
  markTourSeen,
  presentSteps,
  resetTourSession,
  shouldAutoStart,
  stepCounter,
  tourKey,
  tourMove,
} from './lib/tour';
export type { TourCloseReason, TourStep, TourStorage } from './lib/tour';

// «Mi perfil» (personal y panel): foto, nombre, contacto, seguridad y ajustes de este móvil.
export { ProfileScreen, ProfileDevice } from './components/ProfileScreen';
export type { ProfileScreenProps } from './components/ProfileScreen';
export { StaffAvatar, StaffPhotoProvider, initialsTone, useStaffPhotoUrl } from './components/StaffAvatar';
export type { StaffPhotoFetcher } from './components/StaffAvatar';
export {
  BIGFONT_KEY,
  HAPTIC_KEY,
  THEME_KEY,
  applyBigFont,
  applyThemeChoice,
  deviceInitScript,
  hapticEnabled,
  readBigFont,
  readThemeChoice,
  resolveTheme,
} from './lib/device-settings';
export type { ThemeChoice } from './lib/device-settings';
export { PHOTO_MAX_BYTES, PHOTO_OUT_SIDE, PhotoPrepareError, encodeProfilePhoto, photoPlan, prepareProfilePhoto } from './lib/profile-photo';
