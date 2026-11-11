export const staffRoles = ['reception', 'nurse', 'physician', 'admin'] as const;
export type StaffRole = typeof staffRoles[number];
export type Staff = { id: string; role: StaffRole };

export const staffRoleLabels: Record<StaffRole, string> = {
  reception: '受付', nurse: '看護師', physician: '医師', admin: '管理者',
};

export function hasStaffRole(staff: Staff, minimum: StaffRole) {
  return staffRoles.indexOf(staff.role) >= staffRoles.indexOf(minimum);
}
