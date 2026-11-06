import { login, logout, getUser, handleAuthCallback, acceptInvite, requestPasswordRecovery, updateUser } from '@netlify/identity';
window.KaspAuth = { login, logout, getUser, handleAuthCallback, acceptInvite, requestPasswordRecovery, updateUser };
