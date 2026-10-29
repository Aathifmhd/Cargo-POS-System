import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, getToken, setToken, isAdmin, isSuper, can, isDiscreet, discreetUser } from './lib.js';
import { ToastProvider, Loading } from './components/ui.jsx';
import { Login, ApprovalProvider } from './components/auth.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import POS from './pages/POS.jsx';
import Sales from './pages/Sales.jsx';
import SaleView from './pages/SaleView.jsx';
import GrnList from './pages/GrnList.jsx';
import GrnForm from './pages/GrnForm.jsx';
import GrnView from './pages/GrnView.jsx';
import ExtraShort from './pages/ExtraShort.jsx';
import Stock from './pages/Stock.jsx';
import Suppliers from './pages/Suppliers.jsx';
import SupplierView from './pages/SupplierView.jsx';
import Cargo from './pages/Cargo.jsx';
import Customers from './pages/Customers.jsx';
import CustomerView from './pages/CustomerView.jsx';
import Dues from './pages/Dues.jsx';
import Reports from './pages/Reports.jsx';
import SalesProfit from './pages/SalesProfit.jsx';
import Settings from './pages/Settings.jsx';
import Users from './pages/Users.jsx';
import ActionCenter from './pages/ActionCenter.jsx';
import Cheques from './pages/Cheques.jsx';
import { PrintSale, PrintGrn, PrintStickers } from './pages/Print.jsx';

const SettingsCtx = createContext({ settings: {}, reload: () => {} });
export const useSettings = () => useContext(SettingsCtx);

const AuthCtx = createContext({ user: null, logout: () => {} });
export const useAuth = () => useContext(AuthCtx);

/** Live INR → LKR rate, refreshed every minute while the app is open. */
const FxCtx = createContext({ fx: null, reloadFx: () => {} });
export const useFx = () => useContext(FxCtx);
function FxProvider({ children }) {
  const [fx, setFx] = useState(null);
  const reloadFx = useCallback(() => api.get('/fx').then(setFx).catch(() => {}), []);
  useEffect(() => {
    reloadFx();
    const t = setInterval(reloadFx, 60_000);
    return () => clearInterval(t);
  }, [reloadFx]);
  return <FxCtx.Provider value={{ fx, setFx, reloadFx }}>{children}</FxCtx.Provider>;
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = logged out
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);

  const reload = useCallback(() => api.get('/settings').then(setSettings).catch((e) => setError(e.message)), []);

  // Restore the session on start
  useEffect(() => {
    if (!getToken()) { setUser(null); return; }
    api.get('/auth/me').then((d) => setUser(d.user)).catch((e) => {
      if (/log in/i.test(e.message)) setUser(null); else setError(e.message);
    });
  }, []);
  useEffect(() => { if (user) reload(); }, [user, reload]);
  useEffect(() => {
    const out = () => setUser(null);
    window.addEventListener('cargo-pos-logout', out);
    return () => window.removeEventListener('cargo-pos-logout', out);
  }, []);

  // the discreet view: every screen sees a counter user (switched by tapping Settings 5 times)
  const [discreet, setDiscreet] = useState(isDiscreet);
  useEffect(() => {
    const on = () => setDiscreet(isDiscreet());
    window.addEventListener('cargo-pos-view', on);
    return () => window.removeEventListener('cargo-pos-view', on);
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* already gone */ }
    setToken(null);
    setUser(null);
    setSettings(null);
  }, []);

  if (error) {
    return (
      <div className="boot-error">
        <h2>Cannot reach the Cargo POS server</h2>
        <p>Start the backend first: open a terminal in <code>backend</code> and run <code>npm start</code>.</p>
        <p className="muted">{error}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }
  if (user === undefined) return <Loading text="Starting Cargo POS…" />;
  if (!user) return <Login onLoggedIn={setUser} />;
  if (!settings) return <Loading text="Loading your shop…" />;

  // the user as the screens see them: in the discreet view, a counter user (New Sale, Stock, Settings only)
  const shown = discreet ? discreetUser(user) : user;
  return (
    <AuthCtx.Provider value={{ user: shown, logout }}>
      <SettingsCtx.Provider value={{ settings, reload }}>
        <ToastProvider>
          <ApprovalProvider>
          <FxProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/print/sale/:id" element={<PrintSale />} />
                <Route path="/print/grn/:id" element={<PrintGrn />} />
                <Route path="/print/stickers/:id" element={<PrintStickers />} />
                {discreet ? (
                  <Route element={<Layout />}>
                    <Route path="/pos" element={<POS />} />
                    <Route path="/stock" element={<Stock />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="*" element={<Navigate to="/pos" replace />} />
                  </Route>
                ) : (
                <Route element={<Layout />}>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/pos" element={<POS />} />
                  <Route path="/sales" element={<Sales />} />
                  <Route path="/sales/:id" element={<SaleView />} />
                  {can(shown, 'receive_goods') && <>
                    <Route path="/grn" element={<GrnList />} />
                    <Route path="/grn/new" element={<GrnForm />} />
                    <Route path="/grn/:id/edit" element={<GrnForm key="edit" />} />
                    <Route path="/grn/:id" element={<GrnView />} />
                    <Route path="/extra-short" element={<ExtraShort />} />
                  </>}
                  {can(shown, 'suppliers') && <>
                    <Route path="/suppliers" element={<Suppliers />} />
                    <Route path="/suppliers/:id" element={<SupplierView />} />
                    <Route path="/cargo" element={<Cargo />} />
                  </>}
                  {can(shown, 'reports') && <Route path="/reports" element={<Reports />} />}
                  <Route path="/stock" element={<Stock />} />
                  <Route path="/customers" element={<Customers />} />
                  <Route path="/customers/:id" element={<CustomerView />} />
                  {can(shown, 'dues') && <Route path="/dues" element={<Dues />} />}
                  {can(shown, 'cheques') && <Route path="/cheques" element={<Cheques />} />}
                  {can(shown, 'settings') && <Route path="/settings" element={<Settings />} />}
                  {isAdmin(shown) && <Route path="/users" element={<Users />} />}
                  {can(shown, 'action_center') && <Route path="/action-center" element={<ActionCenter />} />}
                  {isSuper(shown) && <Route path="/sales-profit" element={<SalesProfit />} />}
                  <Route path="*" element={<Dashboard />} />
                </Route>
                )}
              </Routes>
            </BrowserRouter>
          </FxProvider>
          </ApprovalProvider>
        </ToastProvider>
      </SettingsCtx.Provider>
    </AuthCtx.Provider>
  );
}
