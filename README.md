# Cargo POS

Point-of-sale and back office for a **wholesale business that imports goods from India and sells them in Sri Lanka**.

- **frontend/**: React 18 + Vite + plain CSS
- **backend/**: Node.js + Express, with data in SQLite through Node's built-in `node:sqlite`, so there is nothing native to compile

## Quick start

Needs Node.js **22.13 or newer** (24 recommended).

```bash
npm run setup      # installs root, backend and frontend packages
npm run seed       # OPTIONAL: fills an empty database with demo data
npm run dev        # API on :4000, app on http://localhost:5180
```

### Running it in the shop (one program)

```bash
npm run build      # builds the React app into frontend/dist
npm start          # backend serves the API and the app on http://localhost:4000
```

Other computers on the shop network can open `http://<this-pc-ip>:4000`.

The data lives in `backend/data/cargo-pos.db`. To back it up, copy that file, or go to **Settings → Download backup**.

## Deploying to Vercel (demo)

`vercel.json` deploys the app as one Vercel project with two services:

| Service | Folder | Public path |
|---|---|---|
| `frontend` | `frontend/` (Vite) | `/` and every page, e.g. `/pos` (falls back to `index.html`) |
| `backend` | `backend/` (Express, `src/server.js`) | `/api/*`, which the backend receives unchanged |

There are no service bindings, because the browser calls `/api` directly and the services never call each other.

> **Demo only. Data is not kept on Vercel.** The backend uses a SQLite file, and on Vercel the only writable place is `/tmp`, which is wiped whenever a new instance starts and isn't shared between instances. Each new instance therefore loads the demo data again. Bills, stock and payments made on the demo can vanish, and you may occasionally be logged out. For real shop use, move the data to a hosted database such as Turso/libSQL, or run the backend on a server with a disk.

The live INR rate refreshes when the dashboard asks for it and the stored rate is older than 5 minutes, because background timers don't run reliably on serverless hosting.

Logins are signed tokens that any running copy can check, so you stay signed in even when Vercel spreads requests across several copies. Set one environment variable in Vercel → Settings → Environment Variables:

| Name | Value |
|---|---|
| `SESSION_SECRET` | any long random text (keep it private) |

Without it, a built-in demo secret is used. That works, but anyone who reads this code could forge a login, so set it.

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

## Live INR rate and product cost

- The dashboard shows the **live INR→LKR rate**. It is fetched every 5 minutes, first from Yahoo Finance (intraday) and then from daily public rates if that fails. The page refreshes every minute.
- Press **Edit** to set the rate by hand, for example to your bank or hawala rate. Switch back to **Live** whenever you like.
- New GRNs and supplier payments start from this rate, and you can still edit it on each one.
- **Paid at receipt:** the goods are costed at the GRN's rate and the cost is fixed.
- **On credit:** the unpaid part of the supplier bill is costed at **today's rate**, so the product cost moves day by day. Each payment fixes its share at the rate it was paid at. Once the bill is fully paid, the cost stops moving.
- A product's cost is the FIFO cost of the stock still on hand, which comes from the newest receipts.

## What it does

| Area | Features |
|---|---|
| **Receive Goods (GRN)** | Supplier, cargo name, bale no, LR no, supplier invoice no, **exchange rate for the package**, and per item: cost in INR per set, pieces per set, number of colours, sizes, sets, **expected selling price** and MRP. Cargo charge (INR) and Sri Lankan expenses (LKR) are added and **spread over items by value**, which gives the **landed cost per set and per piece in LKR**. It also shows a live *landing factor*, expected profit, quick pricing ("expected = cost + X %"), and saves a draft automatically. |
| **New Sale (POS)** | Search or scan by code, category chips, sell **by set or by loose piece**, and a **Cash / Credit** bill. Each line shows **Cost, Expected price and MRP**, and you can click one to use it. A margin badge goes green, amber or red, and there is a loss warning. A **hide cost** toggle keeps cost private when the customer can see the screen. You also get a discount (amount or %), change calculator, advance payment and due date for credit bills, a credit-limit warning, quick-add customer, keyboard shortcuts (F2 / Enter / F9) and printing. |
| **Stock** | Stock is kept in pieces and shown as "12 sets + 3 pcs". Cost is a weighted average of landed cost. There are low-stock alerts (re-order level), a full stock card per product, stock corrections (damaged, return, physical count) and purchase history by bale. |
| **Suppliers** | Contact, GST, bank details and credit days. You see every GRN with **paid, balance and due date**, record payments in INR with the exchange rate (Bank, Hawala, Cash, UPI…), and an "oldest first" automatic settlement. |
| **Customers** | Credit limit, credit days, opening balance, unpaid bills, collections and a WhatsApp payment reminder. |
| **Payments Due** | One screen for *to collect* and *to pay*, grouped into **Overdue / Due in 7 days / Later**. |
| **Reports** | Sales and profit by day, product and customer. Shipments by **cargo company** (cargo cost per piece) and by supplier. Stock value at cost, expected price and MRP. Slow-moving stock. |
| **Other** | Dashboard, printable bills and GRNs, cancelling a bill (stock goes back), JSON backup, and editable shop settings. |

## How landed cost is calculated

```
INR total     = Σ(sets × cost per set) + cargo charge
LKR total     = INR total × exchange rate + LKR expenses
item landed   = item INR × rate + (item share of goods value) × (cargo LKR + expenses)
landed / set  = item landed ÷ sets
landed / pc   = landed / set ÷ pieces per set
```

## API overview

`/api/suppliers`, `/api/customers` (each with `/:id/payments`), `/api/products` (with `/:id/adjust`), `/api/grns`, `/api/sales` (with `/:id/void`), `/api/dues/payables`, `/api/dues/receivables`, `/api/dashboard`, `/api/reports/{sales,shipments,stock}`, `/api/settings`, `/api/backup`.
