const crypto = require('crypto');
const prisma = require('../../config/db');
const env = require('../../config/env');
const { STATUS_MODULE_CODES, resolveStatusFromCodes, resolveStatusIdFromCodes } = require('../../common/utils/status.util');
const { validateTwilioRequest, sendAdditionalWorkApproval } = require('../../providers/whatsapp/whatsapp.service');
const { createStorageProvider } = require('../../providers/storage/storage.provider');
const { refreshJobCardStatus } = require('../jobCards/jobCard.service');
const { DEPARTMENT_ORDER, DEPARTMENT_ALIASES, normalizeDepartment } = require('../../common/utils/department.util');
const { createAuditLog } = require('../../common/utils/audit.util');
const chatService = require('../chat/chat.service');

const storageProvider = createStorageProvider();
const ROLE_ALIASES = {
  body_shop: 'floor_supervisor',
  bodyshop: 'floor_supervisor',
  bodyshop_supervisor: 'floor_supervisor',
  body_shop_supervisor: 'floor_supervisor',
  floor: 'floor_supervisor',
  mechanical_supervisor: 'floor_supervisor',
  water_wash: 'floor_supervisor',
  water_wash_team: 'floor_supervisor'
};
const ROLE_DEPARTMENTS = {
  floor_supervisor: ['mechanical', 'body-shop', 'water-wash'],
  mechanical: 'mechanical',
  mechanic: 'mechanical',
  body_shop_supervisor: ['mechanical', 'body-shop'],
  water_wash_team: 'water-wash',
  water_wash: 'water-wash'
};
const PRIVILEGED_ROLES = new Set(['admin', 'super_admin', 'manager', 'managing_director']);
const MODULE_DEPARTMENTS = {
  'floor-supervisor': ['mechanical', 'body-shop', 'water-wash'],
  'body-shop-supervisor': ['mechanical', 'body-shop'],
  'water-wash': 'water-wash'
};
const PRIVILEGED_MODULES = new Set(['admin', 'manager', 'managing-director']);
const APPROVAL_TYPE_ADDITIONAL_WORK = 'ADDITIONAL_WORK';
const ADDITIONAL_WORK_SCHEMA_STATEMENTS = [
  `
IF COL_LENGTH('job_card_approvals', 'approval_code') IS NULL
BEGIN
  ALTER TABLE job_card_approvals ADD approval_code NVARCHAR(30) NULL;
END
  `,
  `
IF COL_LENGTH('job_card_approvals', 'mechanic_explanation') IS NULL
BEGIN
  ALTER TABLE job_card_approvals ADD mechanic_explanation NVARCHAR(MAX) NULL;
END
  `,
  `
IF COL_LENGTH('job_card_approvals', 'voice_note_url') IS NULL
BEGIN
  ALTER TABLE job_card_approvals ADD voice_note_url NVARCHAR(MAX) NULL;
END
  `,
  `
IF COL_LENGTH('job_card_services', 'parent_job_card_service_id') IS NULL
BEGIN
  ALTER TABLE job_card_services ADD parent_job_card_service_id INT NULL;
END
  `,
  `
IF NOT EXISTS (
  SELECT 1
  FROM sys.foreign_keys
  WHERE name = 'FK_job_card_services_parent_job_card_service'
)
BEGIN
  ALTER TABLE job_card_services
    ADD CONSTRAINT FK_job_card_services_parent_job_card_service
    FOREIGN KEY (parent_job_card_service_id)
    REFERENCES job_card_services(id);
END
  `,
  `
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_job_card_approvals_approval_code_unique'
    AND object_id = OBJECT_ID('job_card_approvals')
)
BEGIN
  CREATE UNIQUE INDEX IX_job_card_approvals_approval_code_unique
    ON job_card_approvals(approval_code)
    WHERE approval_code IS NOT NULL;
END
  `,
  `
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_job_card_services_parent_job_card_service_id'
    AND object_id = OBJECT_ID('job_card_services')
)
BEGIN
  CREATE INDEX IX_job_card_services_parent_job_card_service_id
    ON job_card_services(parent_job_card_service_id);
END
  `
];
let additionalWorkSchemaPromise = null;

const createHttpError = (statusCode, message, data = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.data = data;
  return error;
};

const ensureAdditionalWorkSchema = async () => {
  if (!additionalWorkSchemaPromise) {
    additionalWorkSchemaPromise = (async () => {
      for (const statement of ADDITIONAL_WORK_SCHEMA_STATEMENTS) {
        try {
          await prisma.$executeRawUnsafe(statement);
        } catch (err) {
          console.warn('Additional work schema check notice:', err.message);
        }
      }
    })();
  }

  return additionalWorkSchemaPromise;
};

const normalizeText = (value) => String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');

const buildJobCardIdentifierWhere = (identifier) => {
  const rawId = String(identifier || '').trim();

  if (!rawId) {
    throw createHttpError(400, 'jobCardId is required');
  }

  const parsedId = Number(rawId);
  const isNumericId = Number.isInteger(parsedId) && parsedId > 0;

  const conditions = [
    { slug: rawId },
    { slug: rawId.toLowerCase() },
    { slug: { contains: rawId.toLowerCase() } },
    { jobCardNo: rawId },
    { jobCardNo: rawId.toUpperCase() },
    { jobCardNo: rawId.toLowerCase() },
    { jobCardNo: { contains: rawId } }
  ];

  if (isNumericId) {
    conditions.push({ id: parsedId });
  } else {
    const digitsOnly = rawId.replace(/\D/g, '');
    if (digitsOnly) {
      const parsedDigits = Number(digitsOnly);
      if (Number.isInteger(parsedDigits) && parsedDigits > 0) {
        conditions.push({ id: parsedDigits });
      }
    }
  }

  return { OR: conditions };
};

const normalizeRoleSlug = (roleSlug) => {
  const normalized = String(roleSlug || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return ROLE_ALIASES[normalized] || normalized;
};



const getAllowedDepartments = (user) => {
  if (!user) return ['all'];

  const allowed = new Set();
  let isPrivileged = false;

  if (Array.isArray(user.modules)) {
    for (const mod of user.modules) {
      if (PRIVILEGED_MODULES.has(mod)) isPrivileged = true;
      const dept = MODULE_DEPARTMENTS[mod];
      if (dept) {
        if (Array.isArray(dept)) {
          dept.forEach((d) => allowed.add(d));
        } else {
          allowed.add(dept);
        }
      }
    }
  }

  const rawRoleSlug = user.roleSlug || user.role?.slug || user.role || '';
  const roleSlug = normalizeRoleSlug(rawRoleSlug);
  if (
    PRIVILEGED_ROLES.has(roleSlug) ||
    roleSlug.includes('manager') ||
    roleSlug.includes('admin') ||
    roleSlug.includes('supervisor') ||
    roleSlug.includes('advisor')
  ) {
    isPrivileged = true;
  }

  const deptFromRole = ROLE_DEPARTMENTS[roleSlug];
  if (deptFromRole) {
    if (Array.isArray(deptFromRole)) {
      deptFromRole.forEach((d) => allowed.add(d));
    } else {
      allowed.add(deptFromRole);
    }
  }

  if (isPrivileged || allowed.size === 0) return ['all'];
  return Array.from(allowed);
};

const getDepartmentsForUser = (user, requestedDepartment) => {
  const allowed = getAllowedDepartments(user);
  const normalizedReq = normalizeDepartment(requestedDepartment);

  if (normalizedReq) {
    if (allowed.includes('all') || allowed.includes(normalizedReq)) {
      return [normalizedReq];
    }
    return [normalizedReq];
  }

  if (allowed.includes('all')) {
    return [];
  }

  return allowed;
};

const getDepartmentForUser = (user, requestedDepartment) => {
  const allowed = getDepartmentsForUser(user, requestedDepartment);
  if (allowed.length === 1) {
    return allowed[0];
  }
  if (allowed.length === 0) {
    const norm = normalizeDepartment(requestedDepartment);
    return norm || 'mechanical';
  }
  return allowed[0];
};

const getServiceDepartment = (service) => {
  if (!service) return 'mechanical';
  const category = service.serviceItem && service.serviceItem.category;
  const nameOrSlug = category ? (category.slug || category.name) : (service.serviceName || service.name);
  return normalizeDepartment(nameOrSlug) || 'mechanical';
};

const toStatusResource = (status) => status
  ? {
    id: status.id,
    code: status.statusCode,
    name: status.statusName
  }
  : null;

const toServiceResource = (service) => service ? ({
  id: service.id,
  jobCardServiceId: service.id,
  serviceItemId: service.serviceItemId,
  parentJobCardServiceId: service.parentJobCardServiceId || null,
  name: service.serviceName || service.name || '',
  serviceName: service.serviceName || service.name || '',
  category: service.serviceItem && service.serviceItem.category ? service.serviceItem.category.name : null,
  categorySlug: service.serviceItem && service.serviceItem.category ? service.serviceItem.category.slug : null,
  price: service.price !== null && service.price !== undefined ? Number(service.price) : 0,
  quantity: service.quantity || 1,
  isAdditional: Boolean(service.isAdditional),
  approvalStatus: toStatusResource(service.approvalStatus),
  serviceStatus: toStatusResource(service.serviceStatus)
}) : null;

const toServiceItemResource = (serviceItem) => serviceItem ? ({
  id: serviceItem.id,
  serviceItemId: serviceItem.id,
  name: serviceItem.name,
  serviceName: serviceItem.name,
  category: serviceItem.category ? serviceItem.category.name : null,
  categorySlug: serviceItem.category ? serviceItem.category.slug : null,
  price: serviceItem.defaultPrice !== null && serviceItem.defaultPrice !== undefined ? Number(serviceItem.defaultPrice) : 0,
  defaultPrice: serviceItem.defaultPrice !== null && serviceItem.defaultPrice !== undefined ? Number(serviceItem.defaultPrice) : 0,
  estimatedMinutes: serviceItem.estimatedMinutes || null
}) : null;

const toApprovalResource = (approval) => approval
  ? {
    id: approval.id,
    jobCardId: approval.jobCardId,
    approvalCode: approval.approvalCode,
    approvalType: approval.approvalType,
    totalAmount: approval.totalAmount !== null && approval.totalAmount !== undefined ? Number(approval.totalAmount) : 0,
    whatsappMessageId: approval.whatsappMessageId,
    customerResponse: approval.customerResponse,
    mechanicExplanation: approval.mechanicExplanation || approval.mechanic_explanation || null,
    voiceNoteUrl: approval.voiceNoteUrl || approval.voice_note_url || null,
    sentAt: approval.sentAt,
    respondedAt: approval.respondedAt,
    status: toStatusResource(approval.status),
    services: (approval.services || []).map(toServiceResource).filter(Boolean)
  }
  : null;

const toAdditionalWorkListResource = (approval) => {
  const services = (approval.services || []).map((service) => ({
    ...toServiceResource(service),
    parentService: service.parentService ? toServiceResource(service.parentService) : null
  }));
  const linkedServiceNames = [...new Set(
    services
      .map((service) => service.parentService && service.parentService.serviceName)
      .filter(Boolean)
  )];
  const status = toStatusResource(approval.status);

  return {
    id: approval.id,
    approvalId: approval.id,
    approvalCode: approval.approvalCode,
    approvalType: approval.approvalType,
    jobCardId: approval.jobCardId,
    jobCardNo: approval.jobCard ? approval.jobCard.jobCardNo : null,
    vehicleNumber: approval.jobCard && approval.jobCard.vehicle ? approval.jobCard.vehicle.registrationNo : null,
    customerName: approval.jobCard && approval.jobCard.customer ? approval.jobCard.customer.fullName : null,
    customerMobile: approval.jobCard && approval.jobCard.customer ? approval.jobCard.customer.mobileNo : null,
    makeModel: approval.jobCard && approval.jobCard.vehicle
      ? [approval.jobCard.vehicle.brand && approval.jobCard.vehicle.brand.name, approval.jobCard.vehicle.model].filter(Boolean).join(' ')
      : null,
    locationId: approval.jobCard ? approval.jobCard.locationId : null,
    mechanicExplanation: approval.mechanicExplanation || approval.mechanic_explanation || null,
    voiceNoteUrl: approval.voiceNoteUrl || approval.voice_note_url || null,
    description: approval.mechanicExplanation || services.map((service) => service.serviceName).join(', '),
    linkedServiceNames,
    linkedServiceLabel: linkedServiceNames.length ? linkedServiceNames.join(', ') : null,
    totalAmount: Number(approval.totalAmount),
    requestedAt: approval.sentAt || approval.createdAt,
    respondedAt: approval.respondedAt,
    customerResponse: approval.customerResponse,
    status,
    statusCode: status ? status.code : null,
    statusName: status ? status.name : null,
    services
  };
};

const resolveRequiredStatus = async (tx, moduleCode, statusCodes, label) => {
  const status = await resolveStatusFromCodes(tx, moduleCode, statusCodes);

  if (!status) {
    throw createHttpError(500, `${label} status is not configured`);
  }

  return status;
};

const resolveRequiredStatusId = async (tx, moduleCode, statusCodes, label) => {
  const statusId = await resolveStatusIdFromCodes(tx, moduleCode, statusCodes);

  if (!statusId) {
    throw createHttpError(500, `${label} status is not configured`);
  }

  return statusId;
};

const parsePositiveInt = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createHttpError(400, `${label} must be a positive integer`);
  }

  return parsed;
};

const parseOptionalDate = (value, label) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createHttpError(400, `${label} must be a valid date time`);
  }

  return date;
};

const parsePositiveIntWithFallback = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeStatusFilter = (value) => {
  const normalized = String(value || '').trim().toUpperCase().replace(/[-\s]+/g, '_');
  if (!normalized || normalized === 'ALL') {
    return null;
  }

  if (normalized === 'PENDING_APPROVAL') {
    return 'PENDING';
  }

  return normalized;
};

const normalizeServiceSelections = (serviceItems) => {
  if (!Array.isArray(serviceItems) || serviceItems.length === 0) {
    throw createHttpError(400, 'At least one additional service item is required');
  }

  const seen = new Set();
  return serviceItems.map((item) => {
    const serviceItemId = parsePositiveInt(
      typeof item === 'object' ? (item.serviceItemId || item.id) : item,
      'serviceItemId'
    );
    const quantity = Math.max(1, Number(typeof item === 'object' && item.quantity !== undefined ? item.quantity : 1) || 1);

    if (seen.has(serviceItemId)) {
      throw createHttpError(400, 'Duplicate additional service items are not allowed');
    }
    seen.add(serviceItemId);

    return { serviceItemId, quantity };
  });
};

const getJobCardForAdditionalWork = async (tx, jobCardIdentifier, user) => {
  const identifierWhere = buildJobCardIdentifierWhere(jobCardIdentifier);
  const includeConfig = {
    customer: true,
    vehicle: {
      include: {
        brand: true
      }
    },
    currentStatus: true,
    approvalStatus: true,
    workAssignments: {
      orderBy: { id: 'desc' },
      include: {
        assignedUser: {
          select: { id: true, fullName: true, employeeCode: true, mobileNo: true }
        },
        jobCardService: {
          include: {
            serviceItem: {
              include: {
                category: true
              }
            }
          }
        },
        status: true
      }
    },
    services: {
      include: {
        serviceItem: {
          include: {
            category: true
          }
        },
        approvalStatus: true,
        serviceStatus: true
      },
      orderBy: { id: 'asc' }
    }
  };

  let foundJobCard = null;
  if (user && user.locationId) {
    foundJobCard = await tx.jobCard.findFirst({
      where: {
        ...identifierWhere,
        locationId: Number(user.locationId)
      },
      include: includeConfig
    });
  }

  if (foundJobCard && Array.isArray(foundJobCard.workAssignments) && foundJobCard.workAssignments.length > 0) {
    const bayIds = [...new Set(foundJobCard.workAssignments.map((a) => a.bayId).filter(Boolean))];
    if (bayIds.length > 0) {
      try {
        const bays = await tx.bay.findMany({
          where: { id: { in: bayIds } },
          select: { id: true, bayName: true, bayCode: true }
        });
        const bayMap = new Map(bays.map((b) => [b.id, b]));
        foundJobCard.workAssignments = foundJobCard.workAssignments.map((assignment) => ({
          ...assignment,
          bay: assignment.bayId ? (bayMap.get(assignment.bayId) || null) : null
        }));
      } catch (bayErr) {
        console.error('Failed to resolve bay names for workAssignments:', bayErr);
      }
    }
  }

  return foundJobCard;
};

const getLatestPendingAdditionalApproval = (tx, jobCardId) => {
  return tx.jobCardApproval.findFirst({
    where: {
      jobCardId,
      approvalType: APPROVAL_TYPE_ADDITIONAL_WORK,
      status: {
        statusCode: 'PENDING'
      }
    },
    include: {
      status: true,
      services: {
        include: {
          serviceItem: {
            include: {
              category: true
            }
          },
          approvalStatus: true,
          serviceStatus: true
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });
};

const listRequests = async (query, user) => {
  await ensureAdditionalWorkSchema();

  const requestedDept = query.department || query.category;
  const normalizedReqDept = requestedDept ? normalizeDepartment(requestedDept) : null;
  const targetDepartments = getDepartmentsForUser(user, requestedDept);

  const page = parsePositiveIntWithFallback(query.page, 1);
  const limit = parsePositiveIntWithFallback(query.limit, 20);
  const search = String(query.search || '').trim();
  const statusCode = normalizeStatusFilter(query.status);

  // Apply department filter only if caller specifically requested a single department
  // or user is strictly restricted to one department (e.g. Body Shop Supervisor).
  const isSingleDeptRestricted = targetDepartments.length === 1 && !normalizedReqDept;
  const filterDept = normalizedReqDept || (isSingleDeptRestricted ? targetDepartments[0] : null);

  const where = {
    approvalType: APPROVAL_TYPE_ADDITIONAL_WORK,
    ...(statusCode
      ? {
        status: {
          statusCode
        }
      }
      : {}),
    ...(user && user.locationId
      ? {
        jobCard: {
          locationId: Number(user.locationId)
        }
      }
      : {}),
    services: {
      some: {
        isAdditional: true
      }
    },
    ...(search
      ? {
        OR: [
          { approvalCode: { contains: search } },
          { mechanicExplanation: { contains: search } },
          {
            jobCard: {
              OR: [
                { jobCardNo: { contains: search } },
                { vehicle: { registrationNo: { contains: search } } },
                { customer: { fullName: { contains: search } } }
              ]
            }
          }
        ]
      }
      : {})
  };

  const [requests, total] = await prisma.$transaction([
    prisma.jobCardApproval.findMany({
      where,
      include: {
        status: true,
        jobCard: {
          include: {
            customer: true,
            vehicle: {
              include: {
                brand: true
              }
            }
          }
        },
        services: {
          where: {
            isAdditional: true
          },
          include: {
            serviceItem: {
              include: {
                category: true
              }
            },
            parentService: {
              include: {
                serviceItem: {
                  include: {
                    category: true
                  }
                },
                approvalStatus: true,
                serviceStatus: true
              }
            },
            approvalStatus: true,
            serviceStatus: true
          },
          orderBy: { id: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.jobCardApproval.count({ where })
  ]);

  let filteredRequests = requests;
  if (filterDept) {
    filteredRequests = requests.filter((approval) => {
      const services = approval.services || [];
      return services.some((service) => getServiceDepartment(service) === filterDept);
    });
  }

  const approvalIds = filteredRequests.map((r) => r.id);
  if (approvalIds.length > 0) {
    try {
      const rawDetails = await prisma.$queryRawUnsafe(
        `SELECT id, mechanic_explanation, voice_note_url FROM job_card_approvals WHERE id IN (${approvalIds.join(',')})`
      );
      const rawMap = new Map(rawDetails.map((r) => [r.id, r]));
      for (const req of filteredRequests) {
        const raw = rawMap.get(req.id);
        if (raw) {
          req.mechanicExplanation = req.mechanicExplanation || raw.mechanic_explanation;
          req.voiceNoteUrl = raw.voice_note_url || null;
        }
      }
    } catch (e) {
      console.error('Failed to fetch raw approval details:', e);
    }
  }

  return {
    department: filterDept || 'all',
    requests: filteredRequests.map(toAdditionalWorkListResource),
    meta: {
      page,
      limit,
      total: filterDept ? filteredRequests.length : total,
      totalPages: Math.ceil((filterDept ? filteredRequests.length : total) / limit)
    }
  };
};

const buildJobCardResource = (jobCard) => {
  const activeBays = Array.from(
    new Set(
      (jobCard.workAssignments || [])
        .map((assignment) => assignment.bay && (assignment.bay.bayName || assignment.bay.bayCode))
        .filter(Boolean)
    )
  );
  const bayName = activeBays.join(', ') || jobCard.bayName || (jobCard.bay && jobCard.bay.bayName) || null;

  return {
    id: jobCard.id,
    jobCardNo: jobCard.jobCardNo,
    vehicleNumber: jobCard.vehicle ? jobCard.vehicle.registrationNo : null,
    ownerName: jobCard.customer ? jobCard.customer.fullName : null,
    ownerMobile: jobCard.customer ? jobCard.customer.mobileNo : null,
    makeModel: jobCard.vehicle ? [jobCard.vehicle.brand && jobCard.vehicle.brand.name, jobCard.vehicle.model].filter(Boolean).join(' ') : null,
    status: jobCard.currentStatus ? jobCard.currentStatus.statusCode : null,
    approvalStatus: jobCard.approvalStatus ? jobCard.approvalStatus.statusCode : null,
    createdAt: jobCard.createdAt,
    expectedDeliveryAt: jobCard.expectedDeliveryAt,
    serviceSubtotal: jobCard.serviceSubtotal === null || jobCard.serviceSubtotal === undefined ? null : Number(jobCard.serviceSubtotal),
    taxRate: jobCard.taxRate === null || jobCard.taxRate === undefined ? null : Number(jobCard.taxRate),
    taxAmount: jobCard.taxAmount === null || jobCard.taxAmount === undefined ? null : Number(jobCard.taxAmount),
    discountAmount: jobCard.discountAmount === null || jobCard.discountAmount === undefined ? null : Number(jobCard.discountAmount),
    finalAmount: jobCard.finalAmount === null || jobCard.finalAmount === undefined ? null : Number(jobCard.finalAmount),
    technician: Array.from(
      new Set(
        (jobCard.workAssignments || [])
          .map((assignment) => assignment.assignedUser && assignment.assignedUser.fullName)
          .filter(Boolean)
      )
    ).join(', ') || null,
    bayName
  };
};

const listAvailableServiceItems = async (tx, department) => {
  const allItems = await tx.serviceItem.findMany({
    where: {
      isActive: true,
      category: {
        isActive: true
      }
    },
    include: {
      category: true
    },
    orderBy: { name: 'asc' }
  });

  if (!department || department === 'all') {
    return allItems;
  }

  const deptItems = allItems.filter((item) => {
    const catName = item.category ? (item.category.slug || item.category.name) : item.name;
    return normalizeDepartment(catName) === department;
  });

  return deptItems;
};

const getContext = async (jobCardIdentifier, query, user) => {
  await ensureAdditionalWorkSchema();

  const department = getDepartmentForUser(user, query.department || query.category);

  const jobCard = await getJobCardForAdditionalWork(prisma, jobCardIdentifier, user);

  if (!jobCard) {
    throw createHttpError(404, 'Job card not found');
  }

  const serviceItems = (await listAvailableServiceItems(prisma, department)) || [];
  const pendingApproval = await getLatestPendingAdditionalApproval(prisma, jobCard.id);

  const parentCandidates = (jobCard.services || []).filter((service) => service && !service.isAdditional);
  const deptParentServices = parentCandidates.filter((service) => getServiceDepartment(service) === department);
  const eligibleParentServices = deptParentServices.length > 0 ? deptParentServices : parentCandidates;

  return {
    department: typeof department === 'string' ? department : (Array.isArray(department) ? department[0] : 'mechanical'),
    jobCard: buildJobCardResource(jobCard),
    currentServices: (jobCard.services || []).map(toServiceResource).filter(Boolean),
    eligibleParentServices: eligibleParentServices.map(toServiceResource).filter(Boolean),
    availableServices: serviceItems.map(toServiceItemResource).filter(Boolean),
    pendingApproval: toApprovalResource(pendingApproval)
  };
};

const generateApprovalCode = async (tx) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `AW${crypto.randomInt(100000, 999999)}`;
    const existing = await tx.jobCardApproval.findFirst({
      where: { approvalCode: code },
      select: { id: true }
    });

    if (!existing) {
      return code;
    }
  }

  throw createHttpError(500, 'Could not generate approval code');
};

const createRequest = async (jobCardIdentifier, payload, user) => {
  await ensureAdditionalWorkSchema();

  const explanation = String(payload.mechanicExplanation || payload.explanation || payload.notes || '').trim();
  if (explanation.length < 5) {
    throw createHttpError(400, 'Mechanic explanation is required');
  }

  let voiceNoteUrl = payload.voiceNoteUrl || payload.audioUrl || payload.voiceUrl || (Array.isArray(payload.mediaUrl) ? payload.mediaUrl[0] : payload.mediaUrl) || null;
  if (voiceNoteUrl && typeof voiceNoteUrl === 'string' && voiceNoteUrl.startsWith('data:') && storageProvider && typeof storageProvider.uploadDataUrl === 'function') {
    try {
      voiceNoteUrl = await storageProvider.uploadDataUrl(voiceNoteUrl, 'voice-notes');
    } catch (uploadErr) {
      console.error('Failed to upload Base64 voice note to Azure Blob Storage:', uploadErr);
    }
  }

  const department = getDepartmentForUser(user, payload.department || payload.category);
  const parentJobCardServiceId = parsePositiveInt(payload.parentJobCardServiceId, 'parentJobCardServiceId');
  const selections = normalizeServiceSelections(payload.serviceItems || payload.services);
  const expectedDeliveryAt = parseOptionalDate(payload.expectedDeliveryAt, 'expectedDeliveryAt');

  const result = await prisma.$transaction(async (tx) => {
    const jobCard = await getJobCardForAdditionalWork(tx, jobCardIdentifier, user);
    if (!jobCard) {
      throw createHttpError(404, 'Job card not found');
    }

    const parentService = jobCard.services.find((service) => service.id === parentJobCardServiceId);
    if (!parentService) {
      throw createHttpError(400, 'Parent job card service is invalid');
    }

    const serviceItems = await tx.serviceItem.findMany({
      where: {
        id: {
          in: selections.map((selection) => selection.serviceItemId)
        },
        isActive: true,
        category: {
          isActive: true
        }
      },
      include: {
        category: true
      }
    });
    const serviceItemMap = new Map(serviceItems.map((item) => [item.id, item]));

    if (serviceItems.length !== selections.length) {
      throw createHttpError(400, 'One or more selected service items are invalid or inactive');
    }

    const pendingApprovalStatus = await resolveRequiredStatus(tx, STATUS_MODULE_CODES.APPROVAL_STATUS, ['PENDING'], 'Pending approval');
    const pendingServiceStatusId = await resolveRequiredStatusId(tx, STATUS_MODULE_CODES.JOB_CARD_SERVICE, ['PENDING'], 'Pending job card service');
    const approvalCode = await generateApprovalCode(tx);
    const totalAmount = selections.reduce((sum, selection) => {
      const serviceItem = serviceItemMap.get(selection.serviceItemId);
      return sum + (Number(serviceItem.defaultPrice) * selection.quantity);
    }, 0);

    const approval = await tx.jobCardApproval.create({
      data: {
        jobCardId: jobCard.id,
        statusId: pendingApprovalStatus.id,
        approvalCode,
        approvalType: APPROVAL_TYPE_ADDITIONAL_WORK,
        totalAmount,
        customerResponse: null,
        sentAt: new Date(),
        respondedAt: null,
        createdById: user && user.userId ? user.userId : null
      }
    });

    await tx.$executeRaw`
      UPDATE job_card_approvals
      SET mechanic_explanation = ${explanation},
          voice_note_url = ${voiceNoteUrl || null}
      WHERE id = ${approval.id}
    `;

    const activeAssignment = jobCard.workAssignments.find(
      (wa) => getServiceDepartment(wa.jobCardService) === department
    );

    const createdServices = [];
    for (const selection of selections) {
      const serviceItem = serviceItemMap.get(selection.serviceItemId);
      const createdService = await tx.jobCardService.create({
        data: {
          jobCardId: jobCard.id,
          approvalId: approval.id,
          parentJobCardServiceId,
          serviceItemId: serviceItem.id,
          approvalStatusId: pendingApprovalStatus.id,
          serviceStatusId: pendingServiceStatusId,
          serviceName: serviceItem.name,
          price: Number(serviceItem.defaultPrice),
          quantity: selection.quantity,
          isAdditional: true,
          createdById: user && user.userId ? user.userId : null
        },
        include: {
          serviceItem: {
            include: {
              category: true
            }
          },
          approvalStatus: true,
          serviceStatus: true
        }
      });
      createdServices.push(createdService);
    }

    if (expectedDeliveryAt) {
      await tx.jobCard.update({
        where: { id: jobCard.id },
        data: {
          expectedDeliveryAt,
          modifiedById: user && user.userId ? user.userId : null
        }
      });
    }

    const updatedApproval = await tx.jobCardApproval.findUnique({
      where: { id: approval.id },
      include: {
        status: true,
        services: {
          include: {
            serviceItem: {
              include: {
                category: true
              }
            },
            approvalStatus: true,
            serviceStatus: true
          }
        }
      }
    });

    await createAuditLog(tx, {
      moduleCode: 'additional-work',
      moduleName: 'Additional Work',
      tableName: 'job_card_approvals',
      recordId: approval.id,
      actionType: 'CREATE',
      performedByUserId: user && (user.userId || user.id) ? (user.userId || user.id) : 1,
      recordName: `${jobCard.jobCardNo} - ${approvalCode}`,
      comments: `Additional work requested: ${createdServices.map((s) => s.serviceName).join(', ')}`,
      locationId: jobCard.locationId,
      details: [
        { fieldName: 'approvalCode', oldValue: null, newValue: approvalCode, dataType: 'string' },
        { fieldName: 'totalAmount', oldValue: null, newValue: totalAmount, dataType: 'number' },
        { fieldName: 'services', oldValue: null, newValue: createdServices.map((s) => s.serviceName).join(', '), dataType: 'string' },
        { fieldName: 'explanation', oldValue: null, newValue: explanation, dataType: 'string' }
      ]
    });

    return {
      jobCard,
      approval: updatedApproval,
      services: createdServices,
      explanation,
      voiceNoteUrl
    };
  }, { timeout: 30000 });

  try {
    const realCustomerMobile = result.jobCard.customer?.mobileNo || result.jobCard.customer?.mobile || '';
    const jobCardForMsg = {
      ...result.jobCard,
      customer: {
        ...(result.jobCard.customer || {}),
        mobileNo: realCustomerMobile
      }
    };

    const twilioRes = await sendAdditionalWorkApproval({
      jobCard: jobCardForMsg,
      approval: result.approval,
      services: result.services,
      explanation: result.explanation,
      voiceNoteUrl: result.voiceNoteUrl
    });
    const maskedMobile = realCustomerMobile ? `${realCustomerMobile.slice(0, 3)}****${realCustomerMobile.slice(-4)}` : 'N/A';
    console.log('[WhatsApp Success] Sent message to:', maskedMobile, '| SID:', twilioRes?.sid || 'N/A');

    try {
      const customerName = result.jobCard.customer?.fullName || 'Customer';
      const vehicleNo = result.jobCard.vehicle?.registrationNo || 'your vehicle';
      const serviceLines = (result.services || []).map((service, index) => {
        const lineTotal = Number(service.price || 0) * Number(service.quantity || 1);
        const serviceName = service.serviceItem?.name || service.serviceName || service.name || 'Service';
        return `${index + 1}. ${serviceName} x${service.quantity || 1} - Rs. ${lineTotal.toLocaleString('en-IN')}`;
      });

      const approvalMessageText = [
        'Additional Work Approval Required 🔧',
        `Hello ${customerName}, your vehicle ${vehicleNo} needs approval for additional work.`,
        '',
        `Job Card: ${result.jobCard.jobCardNo}`,
        `Approval Code: ${result.approval.approvalCode}`,
        '',
        'Services Required:',
        ...serviceLines,
        '',
        result.explanation ? `Mechanic Note: ${result.explanation}` : null,
        `Total Amount: Rs. ${Number(result.approval.totalAmount || 0).toLocaleString('en-IN')}`
      ].filter(Boolean).join('\n');

      await chatService.addMessageToChat({
        jobCardId: result.jobCard.id,
        customerId: result.jobCard.customerId,
        customerMobile: realCustomerMobile,
        senderType: 'ADVISOR',
        senderName: 'Service Advisor',
        text: approvalMessageText,
        mediaUrl: result.voiceNoteUrl || null,
        twilioSid: twilioRes?.sid || null,
        status: 'sent'
      });
    } catch (chatErr) {
      console.warn('[Chat] Failed to sync request to chat history:', chatErr.message);
    }
  } catch (error) {
    console.error('[WhatsApp Error] Failed to send Twilio WhatsApp message:', error?.message || error);
  }

  return {
    approval: toApprovalResource(result.approval),
    services: result.services.map(toServiceResource)
  };
};

const parseApprovalReply = (reqOrBody) => {
  const bodyObj = typeof reqOrBody === 'object' && reqOrBody !== null ? (reqOrBody.body || reqOrBody) : {};
  const textFields = [
    bodyObj.Body,
    bodyObj.ButtonText,
    bodyObj.ButtonPayload,
    bodyObj.Text,
    bodyObj.ListResponse,
    bodyObj.Title,
    bodyObj.Payload,
    typeof reqOrBody === 'string' ? reqOrBody : ''
  ];
  const rawText = textFields.filter(Boolean).join(' ').trim().toUpperCase();

  const isApproved = /\b(YES|Y|OK|1|CONFIRM|PROCEED|AGREE|ACCEPT)\b/i.test(rawText) || /APPROV/i.test(rawText) || /ACCEPT/i.test(rawText);
  const isRejected = /\b(NO|N|CANCEL|2|STOP|DECLINE|DISAGREE|REJECT)\b/i.test(rawText) || /REJECT/i.test(rawText);

  const decision = isApproved ? 'APPROVED' : (isRejected ? 'REJECTED' : null);
  const codeMatch = rawText.match(/\b([A-Z]{2}\d{6})\b/i);
  const approvalCode = codeMatch ? codeMatch[1].toUpperCase() : null;

  // Compute a clean, single-word or natural display text for chat history (prevent "ACCEPT ACCEPT YES")
  let displayText = '';
  if (decision === 'APPROVED') {
    displayText = 'Accept';
  } else if (decision === 'REJECTED') {
    displayText = 'Reject';
  } else if (bodyObj.ButtonText && bodyObj.ButtonText.trim()) {
    displayText = bodyObj.ButtonText.trim();
  } else if (bodyObj.Body && bodyObj.Body.trim()) {
    displayText = bodyObj.Body.trim();
  } else if (bodyObj.ButtonPayload && bodyObj.ButtonPayload.trim()) {
    displayText = bodyObj.ButtonPayload.trim();
  } else {
    displayText = rawText || '';
  }

  return {
    decision,
    approvalCode,
    responseText: displayText || rawText || decision || '',
    displayText
  };
};

const fetchAndStoreIncomingMedia = async (mediaUrl, contentType) => {
  if (!mediaUrl) return null;
  try {
    const authHeader = 'Basic ' + Buffer.from(`${env.twilio.accountSid}:${env.twilio.authToken}`).toString('base64');
    const response = await fetch(mediaUrl, {
      headers: {
        Authorization: authHeader
      }
    });

    if (!response.ok) {
      console.warn(`[Twilio Webhook] Failed to download media (${response.status}):`, response.statusText);
      return mediaUrl;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let mimeType = contentType || 'audio/ogg';
    let extension = '.ogg';
    let folder = 'chat-audio';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
      mimeType = 'audio/mp4';
      extension = '.m4a';
    } else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
      mimeType = 'audio/mpeg';
      extension = '.mp3';
    } else if (mimeType.includes('wav')) {
      mimeType = 'audio/wav';
      extension = '.wav';
    } else if (mimeType.includes('amr')) {
      mimeType = 'audio/amr';
      extension = '.amr';
    } else if (mimeType.includes('ogg')) {
      mimeType = 'audio/ogg';
      extension = '.ogg';
    } else if (mimeType.includes('image/jpeg') || mimeType.includes('image/jpg')) {
      mimeType = 'image/jpeg';
      extension = '.jpg';
      folder = 'chat-images';
    } else if (mimeType.includes('image/png')) {
      mimeType = 'image/png';
      extension = '.png';
      folder = 'chat-images';
    } else if (mimeType.includes('image/webp')) {
      mimeType = 'image/webp';
      extension = '.webp';
      folder = 'chat-images';
    } else if (mimeType.includes('pdf')) {
      mimeType = 'application/pdf';
      extension = '.pdf';
      folder = 'chat-documents';
    } else if (mimeType.includes('msword') || mimeType.includes('wordprocessingml')) {
      mimeType = 'application/pdf';
      extension = '.docx';
      folder = 'chat-documents';
    }

    if (storageProvider && typeof storageProvider.uploadBuffer === 'function' && storageProvider.isConfigured) {
      const uploadRes = await storageProvider.uploadBuffer(buffer, {
        folder,
        mimeType,
        extension
      });

      if (uploadRes?.public_id) {
        try {
          return storageProvider.generateSasUrl(uploadRes.public_id, 86400 * 30);
        } catch (sasErr) {
          return uploadRes.url;
        }
      }
      return uploadRes?.url || mediaUrl;
    }

    return mediaUrl;
  } catch (err) {
    console.error('[Twilio Webhook] Error caching incoming media to storage:', err?.message || err);
    return mediaUrl;
  }
};

const handleTwilioWebhook = async (req) => {
  await ensureAdditionalWorkSchema();

  const numMedia = parseInt(req.body?.NumMedia || '0', 10);
  const mediaUrl0 = req.body?.MediaUrl0 || null;
  const mediaContentType0 = req.body?.MediaContentType0 || '';

  // Handle Twilio message delivery status callbacks (e.g. sent, delivered, read)
  if (req.body && req.body.MessageStatus && !req.body.Body && !req.body.ButtonPayload && !req.body.ButtonText && numMedia === 0) {
    const messageSid = req.body.MessageSid || req.body.SmsSid;
    const messageStatus = req.body.MessageStatus || req.body.SmsStatus;
    if (messageSid && messageStatus) {
      await chatService.updateMessageStatusByTwilioSid(messageSid, messageStatus);
    }
    return {
      alreadyResponded: false,
      message: `Status callback processed: ${messageStatus}`
    };
  }

  // Pre-fetch incoming media if customer sent voice note or media attachment
  let incomingMediaUrl = null;
  if (numMedia > 0 && mediaUrl0) {
    incomingMediaUrl = await fetchAndStoreIncomingMedia(mediaUrl0, mediaContentType0);
  }

  const { decision, approvalCode, responseText, displayText } = parseApprovalReply(req);

  // If customer sent a message that is not YES/NO (e.g. "Hello", "What about service", voice note, questions)
  if (!decision) {
    const fromNumber = String(req.body?.From || '').replace(/\D/g, '');
    const mobileDigits = fromNumber.length >= 10 ? fromNumber.slice(-10) : null;
    let incomingText = displayText || req.body?.Body || responseText || '';
    let incomingMediaType = null;
    if (incomingMediaUrl) {
      if (mediaContentType0.startsWith('image/')) {
        incomingMediaType = 'image';
        if (!incomingText) incomingText = '📷 Photo';
      } else if (mediaContentType0.includes('pdf') || mediaContentType0.includes('document') || mediaContentType0.includes('msword')) {
        incomingMediaType = 'document';
        if (!incomingText) incomingText = '📄 Document';
      } else {
        incomingMediaType = 'audio';
        if (!incomingText) incomingText = '🎤 Voice message';
      }
    }

    // Find active job card for this customer phone
    const activeJobCard = mobileDigits ? await chatService.findActiveJobCardByMobile(mobileDigits) : null;

    if (activeJobCard) {
      await chatService.addMessageToChat({
        jobCardId: activeJobCard.id,
        customerId: activeJobCard.customerId,
        customerMobile: mobileDigits || activeJobCard.customer?.mobileNo,
        senderType: 'CUSTOMER',
        senderName: req.body?.ProfileName || activeJobCard.customer?.fullName || 'Customer',
        text: incomingText,
        mediaUrl: incomingMediaUrl,
        mediaType: incomingMediaType
      });
    }

    // Check if the user is asking specifically about how to approve or first greeting
    const isGreeting = /^(HI|HELLO|HEY|HELP)\b/i.test((incomingText || '').trim());

    // Only send automated approval instructions if it's an initial greeting / help query
    // Otherwise, allow natural two-way chat so advisor can reply without bot spamming customer
    if (isGreeting && activeJobCard) {
      let pendingApproval = await prisma.jobCardApproval.findFirst({
        where: {
          approvalType: APPROVAL_TYPE_ADDITIONAL_WORK,
          status: { statusCode: 'PENDING' },
          jobCardId: activeJobCard.id
        }
      });

      if (pendingApproval) {
        const jobCardNo = activeJobCard.jobCardNo || '';
        const code = pendingApproval.approvalCode || '';
        return {
          alreadyResponded: false,
          unrecognized: true,
          replyText: `Hello! We received your message. To approve additional work for Job Card #${jobCardNo}, please reply with *YES* (or *YES ${code}*). To reject, reply with *NO* (or *NO ${code}*). Our service advisor is also available here.`
        };
      }
    }

    return {
      alreadyResponded: false,
      unrecognized: true,
      replyText: null
    };
  }

  return prisma.$transaction(async (tx) => {
    let approval = null;

    const includeOptions = {
      jobCard: {
        include: {
          workAssignments: {
            orderBy: { id: 'desc' },
            include: {
              jobCardService: {
                include: {
                  serviceItem: {
                    include: {
                      category: true
                    }
                  }
                }
              }
            }
          }
        }
      },
      status: true,
      services: {
        include: {
          approvalStatus: true,
          serviceStatus: true,
          serviceItem: {
            include: {
              category: true
            }
          }
        }
      }
    };

    if (approvalCode) {
      approval = await tx.jobCardApproval.findFirst({
        where: {
          approvalCode: approvalCode.toUpperCase(),
          approvalType: APPROVAL_TYPE_ADDITIONAL_WORK
        },
        include: includeOptions
      });
    } else {
      const fromNumber = String(req.body?.From || '').replace(/\D/g, '');
      const mobileDigits = fromNumber.length >= 10 ? fromNumber.slice(-10) : null;

      if (mobileDigits) {
        approval = await tx.jobCardApproval.findFirst({
          where: {
            approvalType: APPROVAL_TYPE_ADDITIONAL_WORK,
            status: {
              statusCode: 'PENDING'
            },
            jobCard: {
              customer: {
                OR: [
                  { mobileNo: { contains: mobileDigits } },
                  { alternateMobileNo: { contains: mobileDigits } }
                ]
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          include: includeOptions
        });
      }

      if (!approval) {
        approval = await tx.jobCardApproval.findFirst({
          where: {
            approvalType: APPROVAL_TYPE_ADDITIONAL_WORK,
            status: {
              statusCode: 'PENDING'
            }
          },
          orderBy: { createdAt: 'desc' },
          include: includeOptions
        });
      }
    }

    if (!approval) {
      return {
        alreadyResponded: false,
        notFound: true,
        replyText: 'No pending additional work approval was found matching your request. Please contact your service advisor.'
      };
    }

    if (approval.respondedAt) {
      return {
        approval: toApprovalResource(approval),
        alreadyResponded: true,
        replyText: `Your response for Job Card #${approval.jobCard?.jobCardNo || ''} has already been recorded.`
      };
    }

    const approvalStatus = await resolveRequiredStatus(tx, STATUS_MODULE_CODES.APPROVAL_STATUS, [decision], `${decision.toLowerCase()} approval`);
    const serviceStatusId = decision === 'REJECTED'
      ? await resolveRequiredStatusId(tx, STATUS_MODULE_CODES.JOB_CARD_SERVICE, ['REJECTED'], 'Rejected job card service')
      : null;
    const now = new Date();

    await tx.jobCardApproval.update({
      where: { id: approval.id },
      data: {
        statusId: approvalStatus.id,
        customerResponse: responseText || String(req.body?.Body || '').trim(),
        respondedAt: now,
        modifiedById: null
      }
    });

    const department = approval.services.length > 0 ? getServiceDepartment(approval.services[0]) : null;
    // Prefer an active (not yet completed) assignment for the department.
    // If the mechanic already completed their work before the customer approved,
    // fall back to the most recent completed assignment so the same mechanic
    // is still assigned to the additional work.
    const departmentAssignments = department
      ? approval.jobCard.workAssignments.filter(
        (wa) => getServiceDepartment(wa.jobCardService) === department
      )
      : [];
    const activeAssignment =
      departmentAssignments.find((wa) => !wa.completedAt) ||
      departmentAssignments[0] ||
      null;

    const actualServiceStatusId = serviceStatusId || (
      (decision === 'APPROVED' && activeAssignment)
        ? activeAssignment.jobCardService.serviceStatusId
        : undefined
    );

    await tx.jobCardService.updateMany({
      where: {
        approvalId: approval.id
      },
      data: {
        approvalStatusId: approvalStatus.id,
        ...(actualServiceStatusId ? { serviceStatusId: actualServiceStatusId } : {}),
        modifiedById: null
      }
    });

    if (decision === 'APPROVED' && activeAssignment) {
      for (const service of approval.services) {
        await tx.workAssignment.create({
          data: {
            locationId: approval.jobCard.locationId,
            jobCardId: approval.jobCard.id,
            jobCardServiceId: service.id,
            statusId: activeAssignment.statusId,
            assignedUserId: activeAssignment.assignedUserId,
            bayId: activeAssignment.bayId,
            assignedById: null,
            createdById: null,
            assignedAt: new Date(),
            ...(activeAssignment.startedAt ? { startedAt: new Date() } : {})
          }
        });
      }
    }

    const activeServices = await tx.jobCardService.findMany({
      where: {
        jobCardId: approval.jobCardId,
        approvalStatus: {
          statusCode: { not: 'REJECTED' }
        }
      },
      select: { price: true, quantity: true }
    });

    const serviceSubtotal = activeServices.reduce((sum, s) => sum + (Number(s.price) * s.quantity), 0);
    const taxRate = Number(approval.jobCard.taxRate || 0);
    const discountAmount = Number(approval.jobCard.discountAmount || 0);
    const taxableAmount = Math.max(0, serviceSubtotal - discountAmount);
    const taxAmount = (taxableAmount * taxRate) / 100;
    const finalAmount = taxableAmount + taxAmount;

    await tx.jobCard.update({
      where: { id: approval.jobCardId },
      data: {
        approvalStatusId: approvalStatus.id,
        serviceSubtotal,
        taxAmount,
        finalAmount
      }
    });

    await refreshJobCardStatus(tx, approval.jobCardId, null);

    const updatedApproval = await tx.jobCardApproval.findUnique({
      where: { id: approval.id },
      include: {
        status: true,
        services: {
          include: {
            serviceItem: {
              include: {
                category: true
              }
            },
            approvalStatus: true,
            serviceStatus: true
          }
        }
      }
    });

    await createAuditLog(tx, {
      moduleCode: 'additional-work',
      moduleName: 'Additional Work',
      tableName: 'job_card_approvals',
      recordId: approval.id,
      actionType: decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
      performedByUserId: approval.createdById || approval.jobCard?.createdById || 1,
      recordName: `${approval.jobCard?.jobCardNo || ''} - ${approval.approvalCode}`,
      comments: `Additional work ${decision.toLowerCase()} by customer via WhatsApp`,
      locationId: approval.jobCard?.locationId || null,
      details: [
        {
          fieldName: 'status',
          oldValue: 'PENDING',
          newValue: decision,
          dataType: 'string'
        },
        {
          fieldName: 'customerResponse',
          oldValue: null,
          newValue: responseText || String(req.body?.Body || '').trim(),
          dataType: 'string'
        },
        {
          fieldName: 'finalAmount',
          oldValue: approval.jobCard?.finalAmount,
          newValue: finalAmount,
          dataType: 'number'
        }
      ]
    });

    const actionText = decision === 'APPROVED' ? 'approved' : 'declined';

    try {
      await chatService.addMessageToChat({
        jobCardId: approval.jobCardId,
        customerId: approval.jobCard.customerId,
        customerMobile: approval.jobCard.customer?.mobileNo,
        senderType: 'CUSTOMER',
        senderName: req.body?.ProfileName || 'Customer',
        text: displayText || (decision === 'APPROVED' ? 'Accept' : 'Reject'),
        mediaUrl: incomingMediaUrl
      });
      await chatService.addMessageToChat({
        jobCardId: approval.jobCardId,
        customerId: approval.jobCard.customerId,
        customerMobile: approval.jobCard.customer?.mobileNo,
        senderType: 'SYSTEM',
        senderName: 'Susee System',
        text: `Additional work estimate was ${actionText}.`
      });
    } catch (chatErr) {
      console.warn('[Chat] Failed to sync approval to chat history:', chatErr.message);
    }

    return {
      approval: toApprovalResource(updatedApproval),
      alreadyResponded: false,
      replyText: `Thank you! Your response has been recorded. Additional work for Job Card #${approval.jobCard?.jobCardNo || ''} has been ${actionText}.`
    };
  }, { maxWait: 20000, timeout: 50000 });
};

module.exports = {
  getContext,
  createRequest,
  listRequests,
  handleTwilioWebhook
};
