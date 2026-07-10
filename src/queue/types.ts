export type EmailTaskType =
  | 'verification'
  | 'password_reset'
  | 'invite'
  | 'password_otp'
  | 'campaign'
  | 'generic';

export type EmailTask = {
  id: string;
  batchId?: string;
  type: EmailTaskType;
  to: string;
  subject: string;
  html: string;
  metadata?: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
};

export type UploadTaskType = 'image_process' | 'bulk_import' | 'heavy_upload';

export type UploadTask = {
  id: string;
  batchId?: string;
  type: UploadTaskType;
  userId: number;
  organizationId?: number | null;
  fileName: string;
  filePath: string;
  byteSize: number;
  metadata?: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
};

export type BatchJobKind = 'email_batch' | 'upload_batch';

export type BatchJobStatus = {
  id: string;
  kind: BatchJobKind;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'partial';
  total: number;
  pending: number;
  succeeded: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
  campaignId?: number;
  label?: string;
  organizationId?: number | null;
  createdBy?: number;
  result?: {
    created: number;
    skipped: number;
    total: number;
  };
};

export type EnqueueEmailInput = {
  type: EmailTaskType;
  to: string;
  subject: string;
  html: string;
  batchId?: string;
  metadata?: Record<string, unknown>;
  maxAttempts?: number;
};

export type EnqueueResult = {
  queued: boolean;
  taskId: string;
  batchId?: string;
  inline?: boolean;
};
