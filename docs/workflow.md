# Workflow

1. Clarify: decision/paper vs implementation — do not assume «next» means code  
2. Prompt cites step number + forbidden list  
3. Plan (≤5 points)  
4. **Human approval before code**  
5. Execute on one git branch  
6. Verify with real test  
7. Rollback on money/legal damage — do not patch over financial bugs  

Do not skip index gates (signed ERD → repo reconcile → API acceptance → 10.x in order).

After payment/invoice/Bonus/inventory critical work: start a fresh chat.
