import assert from 'node:assert/strict';
import { GradingConfiguration } from './src/services/gradingService';
import { evaluateStudentVerifiedFeeAccount } from './src/services/libraryBursarService';
import { evaluateStudentRestrictionSignals } from './src/services/portalRestrictionService';
import { NO_DELETE_ROLES, canRoleDeleteInModule, canRoleAccessModule, canRoleMutateModule, canRoleViewBothAttendance, canRoleOfferBursary } from './src/auth/rbac';
import { evaluateBiometricSmsEligibility } from './src/services/biometricSmsService';
import { evaluateLessonAttendanceWindow } from './src/utils/teacherScope';
import { generateReportCardPdfDataUrl } from './src/utils/pdfUtils';
import { A_LEVEL_COMBINATIONS } from './src/constants/schoolStructure';

// 1. Grading: PCB/SubMath Subsidiary Math vs Principal Math
const pcbCombo = A_LEVEL_COMBINATIONS.find((c) => c.code === 'PCB/SubMath')!;
assert.equal(
  GradingConfiguration.determineSubjectCategory('Mathematics', {
    combinationCode: pcbCombo.code,
    subsidiaries: pcbCombo.subsidiaries,
  }),
  'Subsidiary',
  'Mathematics in PCB/SubMath must be Subsidiary'
);
assert.equal(
  GradingConfiguration.determineSubjectCategory('Mathematics', { combinationCode: 'PCM/ICT' }),
  'Principal',
  'Mathematics in PCM/ICT must be Principal'
);
assert.equal(GradingConfiguration.evaluateScore(85, 'O-Level').grade, 'A');
assert.equal(GradingConfiguration.evaluateScore(75, 'A-Level', 'Principal').points, 5);
assert.equal(GradingConfiguration.evaluateScore(60, 'A-Level', 'Subsidiary').points, 1);
assert.equal(GradingConfiguration.evaluateScore(30, 'A-Level', 'Subsidiary').points, 0);

// 2. Fees & Bursaries calculation
const student: any = {
  id: 'stu-1',
  admissionNo: 'NTK-2026-001',
  fullName: 'Test Student',
  className: 'Senior 1',
  stream: 'X',
  studentCategory: 'Day Scholar',
  parentName: 'Parent One',
  parentPhone: '+256700123456',
  status: 'Active',
};
const settings: any = {
  currentAcademicYear: '2026',
  currentTerm: 'Term 3',
  academicYears: [
    {
      id: 'ay-2026',
      year: '2026',
      startDate: '2026-02-01',
      endDate: '2026-12-10',
      status: 'Active',
      terms: [
        {
          name: 'Term 3',
          startDate: '2026-09-01',
          endDate: '2026-12-05',
          minClearancePct: 50,
          feeSchedule: { oLevelByClass: { 'Senior 1': 950000 }, aLevelByClassStream: {} },
        },
      ],
    },
  ],
};
const payments: any[] = [
  { id: 'p1', admissionNo: 'NTK-2026-001', amountUGX: 500000, status: 'Verified', term: 'Term 3', academicYear: '2026', receiptNo: 'R-1', date: '2026-09-02' },
  { id: 'p2', admissionNo: 'NTK-2026-001', amountUGX: 300000, status: 'Pending', term: 'Term 3', academicYear: '2026', receiptNo: 'R-2', date: '2026-09-03' },
  { id: 'p3', admissionNo: 'NTK-2026-001', amountUGX: 100000, status: 'Refunded', term: 'Term 3', academicYear: '2026', receiptNo: 'R-3', date: '2026-09-04' },
];
const bursaries: any[] = [
  { id: 'b1', studentId: 'stu-1', admissionNo: 'NTK-2026-001', academicYear: '2026', term: 'Term 3', bursaryType: 'Partial', amountUGX: 250000, status: 'Active' },
];
const feeRes = evaluateStudentVerifiedFeeAccount({ student, feePayments: payments, bursaries, settings });
assert.equal(feeRes.expectedFee, 950000);
assert.equal(feeRes.verifiedPaid, 400000, '500k verified - 100k refund, pending 300k ignored');
assert.equal(feeRes.bursaryCreditUGX, 250000);
assert.equal(feeRes.balance, 300000, '950k - 400k - 250k = 300k');

// 3. Restriction signals & DOS gate
const restr = evaluateStudentRestrictionSignals({
  student,
  feePayments: payments,
  bursaries,
  financialConflicts: [{ id: 'fc1', studentId: 'stu-1', admissionNo: 'NTK-2026-001', status: 'Active' } as any],
  libraryConflicts: [],
  reportCards: [],
  classResultsSubmissions: [{ id: 'crs1', className: 'Senior 1', stream: 'X', term: 'Term 3', academicYear: '2026', status: 'DOSApproved' } as any],
  settings,
});
assert.equal(restr.isRestricted, true);
assert.equal(restr.dosApproved, true);

// 4. RBAC & SMS rules & Lesson window
assert.ok(NO_DELETE_ROLES.includes('secretary'));
assert.ok(NO_DELETE_ROLES.includes('it_support'));
assert.equal(canRoleDeleteInModule('secretary', 'students'), false);
assert.equal(canRoleDeleteInModule('it_support', 'user-accounts'), false);
assert.equal(canRoleAccessModule('bursar', 'fees'), true);
assert.equal(canRoleAccessModule('secretary', 'fees'), false);
assert.equal(canRoleMutateModule('headteacher', 'attendance'), false);
assert.equal(canRoleViewBothAttendance('director_of_studies'), true);
assert.equal(canRoleViewBothAttendance('subject_teacher'), false);
assert.equal(canRoleOfferBursary('headteacher'), true);
assert.equal(canRoleOfferBursary('director'), true);
assert.equal(canRoleOfferBursary('bursar'), false);

// SMS Eligibility: Day Scholar vs Boarding
assert.equal(evaluateBiometricSmsEligibility({ student, direction: 'ClockIn', punchDate: '2026-10-19', settings }).eligible, true);
assert.equal(evaluateBiometricSmsEligibility({ student, direction: 'ClockOut', punchDate: '2026-10-19', settings }).eligible, true);
const boardingStudent = { ...student, studentCategory: 'Boarding' as const };
assert.equal(evaluateBiometricSmsEligibility({ student: boardingStudent, direction: 'ClockIn', punchDate: '2026-10-19', settings }).eligible, false, 'Mid-term boarding ClockIn must NOT trigger SMS');
assert.equal(evaluateBiometricSmsEligibility({ student: boardingStudent, direction: 'ClockIn', punchDate: '2026-09-01', settings }).eligible, true, 'Term opening day boarding ClockIn triggers SMS');
assert.equal(evaluateBiometricSmsEligibility({ student: boardingStudent, direction: 'ClockOut', punchDate: '2026-12-05', settings }).eligible, true, 'Term closing day boarding ClockOut triggers SMS');

const mondayLesson: any = {
  id: 'les-1',
  dayOfWeek: 'Monday',
  startTime: '08:00',
  endTime: '09:00',
  academicYear: '2026',
  term: 'Term 3',
  className: 'Senior 1',
  stream: 'X',
  subject: 'Mathematics',
  teacherId: 't1',
  teacherName: 'Teacher',
  status: 'Active',
};
const insideWindow = evaluateLessonAttendanceWindow(mondayLesson, '2026-10-19', settings, new Date('2026-10-19T08:15:00'));
assert.equal(insideWindow.allowed, true);
const outsideWindow = evaluateLessonAttendanceWindow(mondayLesson, '2026-10-19', settings, new Date('2026-10-19T14:00:00'));
assert.equal(outsideWindow.allowed, false);

// 5. Multi-page PDF generation with 14 subjects (verify no truncation & valid PDF header)
const subjects14 = Array.from({ length: 14 }, (_, i) => ({
  name: `Subject ${i + 1}`,
  testMark: 35,
  examMark: 40,
  totalMark: 75,
  grade: 'B',
  pointsDisplay: '-',
  assessment: 'Very Good',
}));
const pdfUrl = generateReportCardPdfDataUrl({
  schoolName: 'Ntake Secondary School',
  motto: 'Strive to Excel',
  address: 'Kampala',
  phone: '+256700000000',
  email: 'info@ntake.ac.ug',
  headTeacherName: 'Head Teacher',
  academicLevel: 'O-Level',
  term: 'Term 3',
  academicYear: '2026',
  studentName: 'Test Scholar',
  admissionNo: 'NTK-2026-001',
  className: 'Senior 1',
  stream: 'X',
  subjects: subjects14,
  totalMarks: 1050,
  maxPossibleMarks: 1400,
  average: 75,
  summaryRightLabel1: 'Stream Size',
  summaryRightValue1: '45',
  summaryRightLabel2: 'Overall Grade',
  summaryRightValue2: 'B',
  classTeacherComment: 'Consistent performance across all 14 subjects.',
  headTeacherComment: 'Keep up the good discipline and hard work.',
  issueDate: '2026-11-17',
});
assert.ok(pdfUrl.startsWith('data:application/pdf;base64,'));
const decodedPdf = Buffer.from(pdfUrl.replace('data:application/pdf;base64,', ''), 'base64').toString('latin1');
assert.ok(decodedPdf.includes('Subject 14'), '14th subject must not be truncated');
assert.ok(decodedPdf.includes('/Count 2') || decodedPdf.includes('/Count 3'), 'Must paginate cleanly across multiple pages');

console.log('ALL_DOMAIN_ASSERTIONS_PASSED');
