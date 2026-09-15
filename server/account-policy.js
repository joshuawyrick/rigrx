function memberConflict(existing, companyId) {
  if (!existing) return null;
  if (existing.role === 'admin') return 'That number belongs to a protected administrator account';
  if (existing.role !== 'provider') return 'That number is already registered with a different account type';
  if (Number(existing.company_id) !== Number(companyId))
    return 'That number already belongs to another company';
  if ((existing.member_role || 'owner') === 'owner')
    return 'The company owner cannot be changed into a team member';
  return null;
}

module.exports = { memberConflict };