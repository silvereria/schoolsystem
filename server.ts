import 'dotenv/config';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { writeStructuredLog } from './server/logging';

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

function isValidHttpUrl(raw?: string): raw is string {
  const value = (raw || '').trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function startServer() {
  if (isProduction) {
    throw new Error('Express is development-only. Serve dist/ with Nginx and route PHP through PHP-FPM.');
  }

  const app = express();
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      writeStructuredLog('info', 'http.request.completed', {
        requestId,
        route,
        httpStatus: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', async (req: Request, res: Response) => {
    const phpApiBase = (process.env.PHP_API_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!isValidHttpUrl(phpApiBase)) {
      res.status(503).json({ status: 'down', database: 'down' });
      return;
    }

    try {
      const phpResponse = await fetch(`${phpApiBase}/health.php`, {
        headers: { 'X-Request-ID': String(res.locals.requestId) },
        signal: AbortSignal.timeout(5000),
      });
      const result = await phpResponse.json() as {
        success?: boolean;
        data?: { status?: string; database?: string };
      };
      const up = phpResponse.ok && result.success === true && result.data?.status === 'up';
      res.status(up ? 200 : 503).json({
        status: up ? 'up' : 'down',
        database: up ? 'up' : 'down',
      });
    } catch (error) {
      writeStructuredLog('error', 'health.php_api.unavailable', {
        requestId: String(res.locals.requestId),
        errorCode: 'DB_UNAVAILABLE',
        exceptionType: error instanceof Error ? error.name : 'UnknownError',
      });
      res.status(503).json({ status: 'down', database: 'down' });
    }
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    const smsConfigured =
      isValidHttpUrl(process.env.SMS_API_URL) && Boolean(process.env.SMS_API_KEY?.trim());
    const phpApiBase = (process.env.PHP_API_BASE_URL || '').trim().replace(/\/+$/, '');
    const phpConfigured = isValidHttpUrl(phpApiBase);
    res.json({
      ok: true,
      service: 'ntake-sms-backend',
      timestamp: new Date().toISOString(),
      integrations: {
        smsGatewayConfigured: smsConfigured,
        smsStatus: smsConfigured ? 'Configured' : 'WaitingForExternalIntegration',
        phpApiConfigured: phpConfigured,
        biometricWebhookReady: phpConfigured,
      },
    });
  });

  app.post('/api/biometrics/punch', async (req: Request, res: Response) => {
    const body = req.body as {
      deviceCode?: string;
      deviceSecret?: string;
      biometricId?: string;
      direction?: string;
      punchTimestamp?: string;
      verificationMode?: string;
    };

    const headerSecret = req.header('x-device-token');
    const providedSecret = (body.deviceSecret || headerSecret || '').trim();

    if (!body.deviceCode?.trim() || !body.biometricId?.trim()) {
      res.status(400).json({ accepted: false, error: 'deviceCode and biometricId are required.' });
      return;
    }
    if (!providedSecret || providedSecret.length < 4) {
      res.status(401).json({ accepted: false, error: 'Missing or invalid device secret.' });
      return;
    }

    if (body.direction && !['ClockIn', 'ClockOut'].includes(body.direction)) {
      res.status(400).json({ accepted: false, error: 'Invalid punch direction. Must be ClockIn or ClockOut.' });
      return;
    }
    const direction = body.direction || 'ClockIn';

    if (body.punchTimestamp && Number.isNaN(new Date(body.punchTimestamp).getTime())) {
      res.status(400).json({ accepted: false, error: 'Malformed punch timestamp.' });
      return;
    }
    const punchTimestamp = body.punchTimestamp
      ? new Date(body.punchTimestamp).toISOString()
      : new Date().toISOString();

    const normalizedPayload = {
      deviceCode:       body.deviceCode.trim().toUpperCase(),
      deviceSecret:     providedSecret,
      biometricId:      body.biometricId.trim(),
      direction,
      punchTimestamp,
      verificationMode: (['Face','CardAndPin'].includes(body.verificationMode ?? ''))
                        ? body.verificationMode
                        : 'Fingerprint',
    };

    // ── Forward to PHP authoritative processor ──────────────────
    const phpApiBase = (process.env.PHP_API_BASE_URL || 'http://localhost/school-management/api')
                        .replace(/\/+$/, '');
    const phpUrl     = `${phpApiBase}/biometric-punch.php`;

    try {
      const phpResponse = await fetch(phpUrl, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'X-Device-Token': providedSecret,
        },
        body:    JSON.stringify(normalizedPayload),
        signal:  AbortSignal.timeout(14000),
      });

      const phpResult = await phpResponse.json() as {
        success?: boolean; accepted?: boolean;
        data?: { accepted: boolean; eventId?: string; status?: string;
                 attendanceStatus?: string; smsStatus?: string; message?: string; error?: string };
        message?: string; error?: string;
      };

      // Unwrap { success, data } wrapper or direct response
      const result = (phpResult.data ?? phpResult) as unknown as {
        accepted?: boolean;
        eventId?: string;
        status?: string;
        attendanceStatus?: string;
        smsStatus?: string;
        message?: string;
        error?: string;
      };

      if (!phpResponse.ok || !(result?.accepted ?? phpResult.accepted)) {
        const errMsg = result?.error ?? phpResult.message ?? phpResult.error ?? 'Punch rejected.';
        res.status(phpResponse.ok ? 400 : phpResponse.status).json({ accepted: false, error: errMsg });
        return;
      }

      res.status(200).json({
        accepted:         true,
        eventId:          result?.eventId,
        status:           result?.status           ?? 'Accepted',
        attendanceStatus: result?.attendanceStatus ?? null,
        smsStatus:        result?.smsStatus        ?? 'NotEligible',
        message:          result?.message          ?? `Biometric ${direction} recorded.`,
      });

    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      writeStructuredLog('error', 'biometric.forward.failed', {
        requestId: String(res.locals.requestId),
        errorCode: isTimeout ? 'PHP_FORWARD_TIMEOUT' : 'PHP_FORWARD_FAILED',
        exceptionType: err instanceof Error ? err.name : 'UnknownError',
      });
      res.status(503).json({
        accepted: false,
        error:    isTimeout
                  ? 'Attendance server timed out. Punch may have been received — verify in the admin panel.'
                  : 'Attendance server temporarily unavailable. Please retry.',
      });
    }
  });

  app.post('/api/sms/dispatch', async (req: Request, res: Response) => {
    // Authenticate dispatch requests
    const dispatchSecret = (process.env.INTERNAL_DISPATCH_SECRET || process.env.CRON_SECRET || '').trim();
    if (!dispatchSecret) {
      res.status(503).json({
        delivered: false,
        status: 'Failed',
        reason: 'SMS dispatch is disabled until INTERNAL_DISPATCH_SECRET or CRON_SECRET is configured.',
      });
      return;
    }
    const authorization = req.header('authorization')?.trim() || '';
    const headerSecret = req.header('x-dispatch-secret')?.trim() || '';
    const bearerSecret = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    const providedSecret = bearerSecret || headerSecret;
    if (providedSecret !== dispatchSecret) {
      res.status(401).json({
        delivered: false,
        status: 'Failed',
        reason: 'Unauthorized SMS dispatch request.',
      });
      return;
    }

    const { recipientPhone, message, studentName } = req.body as {
      recipientPhone?: string;
      message?: string;
      studentName?: string;
    };

    if (!recipientPhone?.trim() || !message?.trim()) {
      res.status(400).json({
        delivered: false,
        status: 'Failed',
        reason: 'recipientPhone and message are required.',
      });
      return;
    }

    const apiUrl = process.env.SMS_API_URL?.trim();
    const apiKey = process.env.SMS_API_KEY?.trim();
    const senderId = process.env.SMS_SENDER_ID?.trim() || 'NTAKE_SS';

    if (!isValidHttpUrl(apiUrl) || !apiKey) {
      res.status(200).json({
        delivered: false,
        status: 'WaitingForExternalIntegration',
        reason:
          'SMS gateway API URL / credentials (SMS_API_URL / SMS_API_KEY) are not configured with a valid HTTP(S) endpoint. Attendance punch remains saved; SMS logged honestly as waiting for external integration.',
      });
      return;
    }

    try {
      const gatewayRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          to: recipientPhone.trim(),
          from: senderId,
          message: message.trim(),
          metadata: { studentName: studentName || '' },
        }),
      });

      const responseText = await gatewayRes.text();
      if (!gatewayRes.ok) {
        writeStructuredLog('warning', 'sms.dispatch.failed', {
          requestId: String(res.locals.requestId),
          errorCode: 'SMS_GATEWAY_REJECTED',
          providerStatus: gatewayRes.status,
        });
        res.status(200).json({
          delivered: false,
          status: 'Failed',
          reason: `SMS gateway responded with HTTP ${gatewayRes.status}.`,
        });
        return;
      }

      res.status(200).json({
        delivered: true,
        status: 'Sent',
        providerResponse: responseText.slice(0, 240) || 'Accepted by SMS gateway',
      });
    } catch (error) {
      writeStructuredLog('warning', 'sms.dispatch.failed', {
        requestId: String(res.locals.requestId),
        errorCode: 'SMS_GATEWAY_NETWORK_ERROR',
        exceptionType: error instanceof Error ? error.name : 'UnknownError',
      });
      res.status(200).json({
        delivered: false,
        status: 'Failed',
        reason: 'SMS gateway network error.',
      });
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error instanceof SyntaxError) {
      res.status(400).json({
        ok: false,
        error: 'Malformed JSON request body.',
      });
      return;
    }
    writeStructuredLog('error', 'http.request.failed', {
      requestId: String(res.locals.requestId || ''),
      errorCode: 'UNHANDLED_REQUEST_ERROR',
      exceptionType: error instanceof Error ? error.name : 'UnknownError',
    });
    res.status(500).json({
      ok: false,
      error: 'An unexpected server error occurred.',
    });
  });

  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);

  app.listen(PORT, '127.0.0.1', () => {
    writeStructuredLog('info', 'server.started', { port: PORT });
  });
}

startServer().catch((err) => {
  writeStructuredLog('error', 'server.start.failed', {
    errorCode: 'SERVER_START_FAILED',
    exceptionType: err instanceof Error ? err.name : 'UnknownError',
  });
  process.exit(1);
});
