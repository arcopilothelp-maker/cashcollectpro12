// CashCollect Pro – AR quiz. Runs entirely in the browser: no sign-in, no server, no AI cost.
// To add questions: add an object to a topic's list. "a" is the index (0-3) of the correct option.
(() => {
  const BANK = {
    'Accounts Receivable basics': [
      { q: 'Accounts receivable represents…', o: ['Money the company owes to suppliers', 'Money customers owe the company for goods or services already delivered on credit', 'Cash held in the bank', 'Future sales orders not yet invoiced'], a: 1, e: 'AR is the amount customers owe for sales made on credit.' },
      { q: 'On the balance sheet, accounts receivable is usually shown as…', o: ['A current liability', 'Equity', 'A current asset', 'An expense'], a: 2, e: 'Receivables are expected to turn into cash within a year, so they are a current asset.' },
      { q: 'An invoice dated 1 March with terms "Net 30" is due on…', o: ['1 March', '15 March', '31 March', '30 April'], a: 2, e: 'Net 30 means payment is due 30 days after the invoice date: 1 March + 30 days = 31 March.' },
      { q: 'Payment terms "2/10 Net 30" mean…', o: ['Pay 2% now and the rest in 30 days', '2% discount if paid within 10 days, otherwise full amount due in 30 days', '2 instalments over 10 days', '10% discount after 30 days'], a: 1, e: 'The customer can take a 2% early-payment discount within 10 days; otherwise the full amount is due in 30 days.' },
      { q: 'An ageing report groups open invoices by…', o: ['Customer size', 'Salesperson', 'How many days they are outstanding or past due', 'Invoice amount only'], a: 2, e: 'Ageing buckets (for example 0–30, 31–60, 61–90, 90+ days) show how old the receivables are.' },
      { q: 'The allowance for doubtful accounts is…', o: ['Cash set aside in a separate bank account', 'An estimate of receivables that may not be collected, reducing net AR', 'A discount given to good customers', 'A tax payable'], a: 1, e: 'It is a contra-asset that estimates uncollectible receivables, so AR is shown at its realistic value.' },
      { q: 'Order-to-Cash (O2C) ends when…', o: ['The order is received', 'Goods are shipped', 'The invoice is sent', 'The payment is received and correctly applied'], a: 3, e: 'O2C runs from customer order to cash received and applied against the invoice.' },
      { q: 'A bad-debt write-off happens when…', o: ['A customer pays early', 'A receivable is judged uncollectible and removed from AR with approval', 'An invoice is sent late', 'A credit limit is increased'], a: 1, e: 'Write-offs remove receivables that will not realistically be collected, following the approval policy.' },
    ],
    'Cash application': [
      { q: 'Cash application means…', o: ['Applying for a bank loan', 'Matching incoming customer payments to the correct open invoices', 'Paying suppliers', 'Calculating sales tax'], a: 1, e: 'Cash application records which invoices a customer payment settles.' },
      { q: 'A remittance advice is…', o: ['A reminder sent to a customer', "The customer's details of which invoices (and deductions) a payment covers", 'A bank statement', 'A credit note'], a: 1, e: 'Remittance details tell you how to apply the payment correctly.' },
      { q: '"Unapplied cash" is…', o: ['Cash that has been received but not yet matched to invoices', 'Cash still with the customer', 'Petty cash', 'Cash in transit to a supplier'], a: 0, e: 'Unapplied cash sits on the account until it is matched, which can make customers look overdue when they are not.' },
      { q: 'A customer pays ₹95,000 against a ₹1,00,000 invoice with no explanation. This is a…', o: ['Overpayment', 'Short payment that needs a reason (deduction or dispute)', 'Duplicate payment', 'Advance payment'], a: 1, e: 'Short payments must be investigated: it may be a deduction, discount, dispute or error.' },
      { q: 'Why does slow cash application hurt collections?', o: ['It increases sales', 'Paid invoices still look open, so collectors chase customers who have already paid', 'It reduces bank charges', 'It has no impact'], a: 1, e: 'Accurate, timely application keeps the ageing correct and protects customer relationships.' },
      { q: 'A bank lockbox service…', o: ['Stores company documents', 'Receives customer payments and passes payment and remittance data to the company', 'Locks overdue accounts', 'Calculates interest'], a: 1, e: 'Lockbox speeds up receipt processing and provides data for cash application.' },
      { q: 'The "auto-match rate" in cash application measures…', o: ['Percentage of payments matched to invoices automatically without manual work', 'Number of customers', 'Bank interest earned', 'Credit limit utilisation'], a: 0, e: 'A higher auto-match rate means less manual effort and faster, more accurate application.' },
      { q: 'A payment received with no remittance and an unknown payer should first be…', o: ['Refunded immediately', 'Applied to any invoice', 'Researched (bank reference, amount, open items) and parked as unapplied until identified', 'Written off'], a: 2, e: 'Never guess. Research the payer and keep it unapplied until it can be matched correctly.' },
    ],
    'Credit & debit memos': [
      { q: 'A credit memo (credit note) issued by the seller…', o: ['Increases what the customer owes', 'Reduces what the customer owes', 'Has no effect on AR', 'Is the same as an invoice'], a: 1, e: 'Credit memos reduce the receivable, for example for returns, pricing errors or agreed allowances.' },
      { q: 'A debit memo issued by the seller…', o: ['Reduces what the customer owes', 'Increases what the customer owes, for example for an undercharge or extra charges', 'Refunds the customer', 'Closes the account'], a: 1, e: 'A seller debit memo adds an amount the customer owes.' },
      { q: 'A customer returns damaged goods worth ₹10,000. The seller should issue a…', o: ['Debit memo', 'Credit memo', 'New invoice', 'Payment receipt'], a: 1, e: 'Returned goods reduce what the customer owes, so a credit memo is issued.' },
      { q: 'The seller forgot to bill ₹2,000 of agreed freight. The usual correction is a…', o: ['Credit memo', 'Write-off', 'Debit memo (or supplementary invoice)', 'Refund'], a: 2, e: 'An undercharge is corrected by a debit memo or supplementary invoice.' },
      { q: 'Under GST in India, to reduce the taxable value of an invoice already issued, the supplier issues a…', o: ['Debit note', 'Credit note', 'Delivery challan', 'Proforma invoice'], a: 1, e: 'A GST credit note reduces the taxable value and tax of an earlier invoice (subject to GST rules).' },
      { q: 'A customer sends their own "debit note" and deducts it from payment. The AR team should…', o: ['Accept it automatically', 'Validate it with sales or logistics before issuing any credit, and track it as a deduction', 'Ignore it', 'Write off the whole invoice'], a: 1, e: 'Customer deductions must be validated; valid ones get a credit memo, invalid ones are collected.' },
      { q: 'A good control for credit memos is…', o: ['Anyone can issue them', 'Approval by an authority matrix with a reason code and supporting documents', 'Issue them only at year-end', 'No documentation needed'], a: 1, e: 'Approvals and reason codes prevent revenue leakage and help find root causes.' },
      { q: 'Frequent credit memos for pricing errors suggest…', o: ['Excellent collections', 'A root-cause problem in pricing or billing that should be fixed upstream', 'Customers paying early', 'Nothing important'], a: 1, e: 'Recurring credit memos are a signal to fix the process that creates the error.' },
    ],
    'Credit review': [
      { q: 'The main purpose of a credit review is to…', o: ['Increase sales targets', "Assess a customer's ability and willingness to pay before setting or changing credit terms", 'Calculate salaries', 'Approve supplier payments'], a: 1, e: 'Credit review balances sales growth with the risk of non-payment.' },
      { q: 'The "5 Cs of credit" are…', o: ['Cash, Cost, Credit, Customer, Contract', 'Character, Capacity, Capital, Collateral, Conditions', 'Collect, Call, Chase, Close, Confirm', 'Company, Country, Currency, Contact, Cost'], a: 1, e: 'These are the classic factors used to judge creditworthiness.' },
      { q: 'A credit limit is…', o: ['The maximum outstanding exposure allowed for a customer', 'The minimum order value', 'The interest rate charged', 'The discount percentage'], a: 0, e: 'It caps how much the customer can owe at any time.' },
      { q: 'Which is NOT normally used in a credit review?', o: ['Financial statements', 'Payment history with us', 'Credit bureau or agency reports', "Number of the customer's social media followers"], a: 3, e: 'Reviews rely on financial strength, payment behaviour and independent credit data.' },
      { q: 'A customer is over its credit limit and has overdue invoices. A common control is to…', o: ['Ship more to boost sales', 'Place new orders on credit hold until resolved or approved', 'Increase the limit automatically', 'Cancel all previous invoices'], a: 1, e: 'Credit hold protects exposure while the overdue position is resolved or an exception is approved.' },
      { q: 'Current ratio is calculated as…', o: ['Current assets ÷ current liabilities', 'Revenue ÷ profit', 'Debt ÷ equity', 'Cash ÷ revenue'], a: 0, e: 'It indicates short-term liquidity: the ability to pay near-term obligations.' },
      { q: 'A bank guarantee or letter of credit is used to…', o: ['Increase sales tax', "Reduce credit risk by having a bank commit to pay if the customer doesn't", 'Delay invoicing', 'Replace the invoice'], a: 1, e: 'These instruments shift payment risk from the customer to a bank.' },
      { q: 'Key customer credit limits should be reviewed…', o: ['Never, once set', 'Periodically (for example annually) and when warning signs appear, such as late payments', 'Only when the customer asks', 'Only at company audits'], a: 1, e: 'Regular and trigger-based reviews keep limits aligned with real risk.' },
    ],
    'Collections & disputes': [
      { q: 'The best first step when an invoice becomes overdue is to…', o: ['Send a legal notice', 'Contact the customer to confirm receipt and understand any reason for delay', 'Write it off', 'Stop all future business'], a: 1, e: 'Most delays have a fixable cause: missing PO, GRN, dispute or approval. Find it first.' },
      { q: 'A strong "promise to pay" includes…', o: ['"We will pay soon"', 'A specific amount, date and the person committing, confirmed in writing', 'Only the invoice number', 'A verbal yes'], a: 1, e: 'Specific, documented promises are easier to follow up and more likely to be kept.' },
      { q: 'A customer breaks a payment promise. The best response is to…', o: ['Wait another month', 'Follow up the same day, understand what changed, agree a realistic new commitment and an escalation trigger', 'Immediately go to court', 'Ignore it'], a: 1, e: 'Fast, respectful follow-up keeps control and shows the commitment matters.' },
      { q: 'An invoice is disputed because of a pricing error. Who usually fixes the root cause?', o: ['The customer', 'The pricing or sales team, with the collector coordinating and tracking it', 'The bank', 'Nobody'], a: 1, e: 'Collectors coordinate; the owning team corrects the cause so it does not recur.' },
      { q: 'A sensible escalation order is…', o: ['Legal notice first', 'Collector → AR lead → sales or account owner → finance heads → credit hold → legal as a last resort', 'Sales first, then never follow up', 'Write-off then call'], a: 1, e: 'Escalate step by step, keeping legal action as the last resort.' },
      { q: 'Which approach builds long-term collections success?', o: ['Threatening customers', 'Being firm on facts and respectful with people', 'Avoiding difficult customers', 'Only sending automated reminders'], a: 1, e: 'Automate the process, humanise the relationship.' },
      { q: 'Before calling an overdue customer, a collector should prepare…', o: ['Nothing', 'Open items, history, disputes, previous promises and the goal of the call', 'Only the customer phone number', 'A legal notice'], a: 1, e: 'Preparation makes the call short, credible and productive.' },
      { q: 'Automated reminders work best when…', o: ['They replace all human contact', 'They handle routine follow-ups so people can focus on complex or high-value accounts', 'They are sent daily to every customer', 'They include threats'], a: 1, e: 'Technology does the heavy lifting; people handle judgement and relationships.' },
    ],
    'AR metrics (DSO & more)': [
      { q: 'DSO (Days Sales Outstanding) is commonly calculated as…', o: ['(Accounts receivable ÷ credit sales) × number of days in the period', 'Credit sales ÷ number of customers', 'Cash ÷ revenue × 100', 'Overdue AR ÷ total AR'], a: 0, e: 'DSO shows how many days of sales are tied up in receivables.' },
      { q: 'AR is ₹50 lakh and credit sales for a 90-day quarter are ₹150 lakh. DSO is…', o: ['15 days', '30 days', '45 days', '90 days'], a: 1, e: '(50 ÷ 150) × 90 = 30 days.' },
      { q: 'A falling DSO generally means…', o: ['Customers are paying more slowly', 'Customers are paying faster (cash is collected sooner)', 'Sales are always falling', 'Nothing'], a: 1, e: 'Lower DSO means receivables convert into cash more quickly.' },
      { q: 'CEI (Collection Effectiveness Index) measures…', o: ['Number of calls made', 'How much of the collectible receivables were actually collected in the period', 'Employee satisfaction', 'Number of invoices raised'], a: 1, e: 'CEI close to 100% means very effective collection.' },
      { q: '"Best possible DSO" is based on…', o: ['Only current (not yet due) receivables', 'Only overdue receivables', 'Total sales for the year', 'Cash in bank'], a: 0, e: 'It shows the DSO you would have if nothing were overdue; the gap to actual DSO reflects collection delays.' },
      { q: 'The "promise-kept rate" tells you…', o: ['How many promises to pay were honoured on time', 'How many invoices were raised', 'Number of credit notes', 'Bank charges'], a: 0, e: 'It reveals customer reliability and the quality of promises collectors secure.' },
      { q: 'Percentage of AR over 90 days past due mainly indicates…', o: ['Sales growth', 'Collection risk and potential bad debt', 'Faster cash application', 'Lower prices'], a: 1, e: 'Old receivables are harder to collect and more likely to become bad debt.' },
      { q: 'Dispute cycle time measures…', o: ['How long disputes take to be resolved', 'How many customers dispute', 'The value of sales', 'Days to issue an invoice'], a: 0, e: 'Shorter dispute cycles release cash faster.' },
    ],
  };
  BANK['Mixed – all topics'] = Object.values(BANK).flat();

  const PER_ROUND = 5;
  const $ = (id) => document.getElementById(id);
  let topic, round, idx, score;

  const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const show = (el, on = true) => el.classList.toggle('hidden', !on);

  function renderTopics() {
    const box = $('quizTopics'); box.textContent = '';
    for (const name of Object.keys(BANK)) {
      const b = document.createElement('button'); b.className = 'topic';
      const t = document.createElement('b'); t.textContent = name;
      const n = document.createElement('span'); n.textContent = `${BANK[name].length} questions`;
      b.append(t, n); b.onclick = () => start(name); box.append(b);
    }
  }

  function start(name) {
    topic = name; idx = 0; score = 0;
    if (window.ccpTrack) window.ccpTrack('quiz_start', name);
    // pick random questions and shuffle each question's options
    round = shuffle(BANK[name]).slice(0, PER_ROUND).map(q => {
      const order = shuffle([0, 1, 2, 3]);
      return { q: q.q, e: q.e, o: order.map(i => q.o[i]), a: order.indexOf(q.a) };
    });
    show($('quizTopics'), false); show($('quizEnd'), false); show($('quizBox'));
    $('quizTitle').textContent = name;
    renderQ();
    $('quizBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderQ() {
    const item = round[idx];
    $('quizProgress').textContent = `Question ${idx + 1} of ${round.length}`;
    $('quizScore').textContent = `Score: ${score}`;
    $('quizQ').textContent = item.q;
    const box = $('quizOpts'); box.textContent = '';
    item.o.forEach((text, i) => {
      const b = document.createElement('button'); b.className = 'opt'; b.textContent = text;
      b.onclick = () => answer(i); box.append(b);
    });
    show($('quizExplain'), false); show($('quizNext'), false);
  }

  function answer(i) {
    const item = round[idx];
    const btns = [...$('quizOpts').children];
    btns.forEach((b, k) => { b.disabled = true; if (k === item.a) b.classList.add('right'); else if (k === i) b.classList.add('wrong'); });
    const ok = i === item.a; if (ok) score++;
    const ex = $('quizExplain');
    ex.textContent = (ok ? '✓ Correct. ' : '✗ Not quite. ') + item.e;
    ex.className = 'explain ' + (ok ? 'good' : 'bad');
    $('quizScore').textContent = `Score: ${score}`;
    $('quizNext').textContent = idx + 1 < round.length ? 'Next question' : 'See my result';
    show($('quizNext'));
  }

  function next() {
    if (idx + 1 < round.length) { idx++; renderQ(); return; }
    show($('quizBox'), false); show($('quizEnd'));
    if (window.ccpTrack) window.ccpTrack('quiz_complete', topic);
    $('quizResult').textContent = `You scored ${score} out of ${round.length}`;
    $('quizMsg').textContent = score === round.length ? 'Outstanding! You really know your AR.'
      : score >= 3 ? 'Good work. Play again for a fresh set of questions.'
      : 'Keep learning. Every round gives you new questions and explanations.';
  }

  window.addEventListener('load', () => {
    if (!$('quizTopics')) return;
    renderTopics();
    $('quizNext').onclick = next;
    $('quizAgain').onclick = () => start(topic);
    $('quizOther').onclick = () => { show($('quizEnd'), false); show($('quizTopics')); };
  });
})();
