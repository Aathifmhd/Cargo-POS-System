# Cargo POS

Point-of-sale and back office for a **wholesale business that imports goods from India and sells them in Sri Lanka**.

- **frontend/**: React 18 + Vite + plain CSS
- **backend/**: Node.js + Express, with the data in **MongoDB** (MongoDB Atlas or any MongoDB 6+ replica set; transactions are used for bills, GRNs and payments)

## Quick start

Needs Node.js **22.13 or newer** (24 recommended) and a MongoDB database.

Put the connection in `backend/.env` (copy `backend/.env.example`; this file is never committed):

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/?retryWrites=true&w=majority
MONGODB_DB=cargo_pos
```

```bash
npm run setup      # installs root, backend and frontend packages
npm run seed       # OPTIONAL: fills an empty database with demo data (stock from Settings → Categories & products)
npm run dev        # API on :4000, app on http://localhost:5180
```

To replace the demo stock (removes every product, GRN, sale and payment; keeps suppliers, customers, users and settings):

```bash
node backend/src/seed.js --reset-stock
```

### Running it in the shop (one program)

```bash
npm run build      # builds the React app into frontend/dist
npm start          # backend serves the API and the app on http://localhost:4000
```

Other computers on the shop network can open `http://<this-pc-ip>:4000`.

The data lives in MongoDB (database `cargo_pos`, one collection per kind of record: products, grns, sales, …). Atlas keeps its own backups; you can also download a copy any time from **Settings → Download backup**.

### Moving from the old SQLite version

Earlier versions kept the data in `backend/data/cargo-pos.db`. To copy it into MongoDB once (every id and number is kept):

```bash
npm --prefix backend run migrate -- --replace
```

`--replace` empties the MongoDB collections first; leave it out to stop if MongoDB already has data.

## Deploying to Vercel (demo)

`vercel.json` deploys the app as one Vercel project with two services:

| Service | Folder | Public path |
|---|---|---|
| `frontend` | `frontend/` (Vite) | `/` and every page, e.g. `/pos` (falls back to `index.html`) |
| `backend` | `backend/` (Express, `src/server.js`) | `/api/*`, which the backend receives unchanged |

There are no service bindings, because the browser calls `/api` directly and the services never call each other.

Every running copy of the backend uses the same MongoDB database, so the data is kept and shared on Vercel. In MongoDB Atlas → **Network Access**, allow `0.0.0.0/0` (Vercel has no fixed address).

The live INR rate refreshes when the dashboard asks for it and the stored rate is older than 5 minutes, because background timers don't run reliably on serverless hosting.

Set these in Vercel → Settings → Environment Variables (Production and Preview), then redeploy:

| Name | Value |
|---|---|
| `MONGODB_URI` | the Atlas connection string (with the database user's password) |
| `MONGODB_DB` | `cargo_pos` |
| `SESSION_SECRET` | optional: any long random text. Without it, a random secret is created once and kept in the database. |

Logins are signed tokens that any running copy can check; logging out and one-time approvals are recorded in the database, so they hold across copies too.

Test locally with `vercel dev`, then deploy by importing the GitHub repo at vercel.com/new.

## Logins and admin approval

- The default admin is **admin / admin123**, created on first start. Change it under *Users & Security*, or from the user menu at the bottom left.
- The demo seed also adds the cashier **cashier / cashier123**.
- When a **cashier** makes an important change, the screen asks for an **admin username and password**. Examples: a customer's credit limit, a price change, selling below cost, a credit bill over the limit, cancelling a bill, a stock correction, deleting a GRN or payment, or changing settings. Each approval works once only. Every change, and who approved it, goes into the **Activity log**.

## Billing keys

The entry row works left to right: **code → qty → price → dis %**, pressing Enter after each one adds the line. `U` switches sets and pieces, and `*` in the code box lists every product.

On the bill: `↓` (from an empty code box) goes to the bill, `↑↓` moves, `Space` edits qty and price, `P` edits the price, `+/−` changes qty, `Delete` removes and `Ctrl+↑↓` moves the line.

Other keys: `` ` `` show or hide cost and profit · `F1` code box · `F4` customer · `F8` bill discount · `Enter Enter` or `F10` take payment (asks Cash or Credit) · `F7`/`Ctrl+H` hold · `F5` held bills · `F12` reprint last bill · `Ctrl+Delete` clear · `?` all keys.

Anywhere: `F2` dashboard · `F3` new sale · `F9` bills · `F7` take a payment.

## Costing rate and the live INR rate

- The dashboard shows the **live INR→LKR rate**. It is fetched every 5 minutes, first from Yahoo Finance (intraday) and then from daily public rates if that fails. The page refreshes every minute.
- Press **Edit** to set the rate by hand, for example to your bank's rate. Switch back to **Live** whenever you like.
- The live rate is **for reference only**. It never changes any cost.
- Every cost uses one fixed **costing rate** (Settings → Exchange rate, **Rs 3.50 per ₹1** by default): GRNs, cost per piece, and supplier payments. Paid or on credit, the cost does not move.
- Changing the costing rate in Settings re-costs every GRN and the stock in one go.
- A product's cost is the FIFO cost of the stock still on hand, which comes from the newest receipts.

## What it does

| Area | Features |
|---|---|
| **Receive Goods (GRN)** | Supplier, cargo name, **cargo charge (LKR)**, supplier invoice no. Items are entered one at a time in a card (category → product → **product name** from Settings, each can be added on the spot, pieces per set, sets, **extra or short pieces**, sizes, billed per piece in INR) and added to a list grouped by category, where each can be edited. The cargo charge is **spread over items by value**, giving the **cost per piece in LKR**. **Selling price and MRP per piece** fill in automatically from Settings → Price & billing (cost + %, rounded) and can be changed. A draft is saved automatically. A GRN entered wrongly can be **edited** (same GRN number; stock moves by the difference; Super Admin password). |
| **New Sale (POS)** | Search or scan by code and sell **by the piece**, on a **Cash / Credit** bill. Each line shows **Cost, Expected price and MRP per piece**, and you can click one to use it. A **hide cost** key (`) keeps cost private when the customer can see the screen. Also: discounts (amount or %), change calculator, advance payment and due date for credit bills, credit-limit approval, quick-add customer, held bills, keyboard shortcuts and printing. |
| **Stock** | Stock is kept and shown in pieces. Cost is the cost of the pieces still in stock (oldest sold first). There are low-stock alerts (re-order level), a full stock card per product, stock corrections (damaged, return, physical count) and purchase history by GRN. |
| **Suppliers** | Contact, GST, bank details and credit days. You see every GRN with **paid, balance and due date**, record payments in INR at the costing rate (Bank, Cash, Cheque, UPI…), and an "oldest first" automatic settlement. Adding, editing or deleting a supplier needs the Super Admin password. |
| **Customers** | Credit limit, credit days, opening balance, unpaid bills, collections and a WhatsApp payment reminder. Adding, editing or deleting a customer needs the Super Admin password. |
| **Payments Due** | One screen for *to collect* and *to pay*, grouped into **Overdue / Due in 7 days / Later**. |
| **Reports** | Sales and profit by day, product and customer. Shipments by **cargo company** (cargo cost per piece) and by supplier. Stock value at cost, expected price and MRP. Slow-moving stock. |
| **Extra & Short** | Every GRN line where the bale did not match the bill: extra pieces (billed by the supplier) and short pieces (paid, not received), with totals. |
| **Other** | Dashboard, printable bills and GRNs, cancelling a bill (stock goes back), JSON backup, and editable shop settings. |

## How cost is calculated

```
INR total     = Σ(pieces billed × billed per piece)
LKR total     = INR total × costing rate (3.5) + cargo charge (LKR)
item INR      = (sets × pieces per set + extra pieces) × billed per piece
item cost     = item INR × costing rate + (item share of goods value) × (cargo charge in LKR)
cost / piece  = item cost ÷ pieces actually received (sets × pieces per set + extra − short)
```

## API overview

`/api/suppliers`, `/api/customers` (each with `/:id/payments`), `/api/products` (with `/:id/adjust`), `/api/grns`, `/api/sales` (with `/:id/void`), `/api/dues/payables`, `/api/dues/receivables`, `/api/dashboard`, `/api/reports/{sales,shipments,stock}`, `/api/settings`, `/api/backup`.
